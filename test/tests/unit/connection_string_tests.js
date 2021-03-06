'use strict';

const parseConnectionString = require('../../../lib/uri_parser');
const fs = require('fs');
const punycode = require('punycode');
const MongoParseError = require('../../../lib/error').MongoParseError;
const chai = require('chai');
const expect = chai.expect;
chai.use(require('chai-subset'));

// NOTE: These are cases we could never check for unless we write out own
//       url parser. The node parser simply won't let these through, so we
//       are safe skipping them.
const skipTests = [
  'Invalid port (negative number) with hostname',
  'Invalid port (non-numeric string) with hostname',
  'Missing delimiting slash between hosts and options',

  // These tests are only relevant to the native driver which
  // cares about specific keys, and validating their values
  'Unrecognized option keys are ignored',
  'Unsupported option values are ignored',

  // We don't actually support `wtimeoutMS` which this test depends upon
  'Deprecated (or unknown) options are ignored if replacement exists',

  // We already handle this case in different ways
  'may support deprecated gssapiServiceName option (GSSAPI)'
];

describe('Connection String', function() {
  it('should provide a default port if one is not provided', function(done) {
    parseConnectionString('mongodb://hostname', function(err, result) {
      expect(err).to.not.exist;
      expect(result.hosts[0].port).to.equal(27017);
      done();
    });
  });

  it('should correctly parse arrays', function(done) {
    parseConnectionString('mongodb://hostname?foo=bar&foo=baz', function(err, result) {
      expect(err).to.not.exist;
      expect(result.options.foo).to.deep.equal(['bar', 'baz']);
      done();
    });
  });

  it('should parse boolean values', function(done) {
    parseConnectionString('mongodb://hostname?retryWrites=1', function(err, result) {
      expect(err).to.not.exist;
      expect(result.options.retryWrites).to.equal(false);

      parseConnectionString('mongodb://hostname?retryWrites=false', function(err, result) {
        expect(err).to.not.exist;
        expect(result.options.retryWrites).to.equal(false);

        parseConnectionString('mongodb://hostname?retryWrites=true', function(err, result) {
          expect(err).to.not.exist;
          expect(result.options.retryWrites).to.equal(true);
          done();
        });
      });
    });
  });

  it('should parse compression options', function(done) {
    parseConnectionString(
      'mongodb://localhost/?compressors=zlib&zlibCompressionLevel=4',
      (err, result) => {
        expect(err).to.not.exist;
        expect(result.options).to.have.property('compression');
        expect(result.options.compression).to.eql({
          compressors: ['zlib'],
          zlibCompressionLevel: 4
        });

        done();
      }
    );
  });

  it('should parse `readConcernLevel`', function(done) {
    parseConnectionString('mongodb://localhost/?readConcernLevel=local', (err, result) => {
      expect(err).to.not.exist;
      expect(result.options).to.have.property('readConcern');
      expect(result.options.readConcern).to.eql({ level: 'local' });
      done();
    });
  });

  it('should parse `authMechanismProperties`', function(done) {
    parseConnectionString(
      'mongodb://user%40EXAMPLE.COM:secret@localhost/?authMechanismProperties=SERVICE_NAME:other,SERVICE_REALM:blah,CANONICALIZE_HOST_NAME:true&authMechanism=GSSAPI',
      (err, result) => {
        expect(err).to.not.exist;

        const options = result.options;
        expect(options).to.deep.include({
          gssapiServiceName: 'other',
          gssapiServiceRealm: 'blah',
          gssapiCanonicalizeHostName: true
        });

        expect(options).to.have.property('authMechanism');
        expect(options.authMechanism).to.equal('GSSAPI');

        done();
      }
    );
  });

  it('should parse a numeric authSource with variable width', function(done) {
    parseConnectionString('mongodb://localhost/?authSource=0001', (err, result) => {
      expect(err).to.not.exist;
      expect(result.options).to.have.property('authSource');
      expect(result.options.authSource).to.equal('0001');

      done();
    });
  });

  describe('validation', function() {
    it('should validate compression options', function(done) {
      parseConnectionString('mongodb://localhost/?zlibCompressionLevel=15', err => {
        expect(err).to.exist;

        parseConnectionString('mongodb://localhost/?compressors=bunnies', err => {
          expect(err).to.exist;

          done();
        });
      });
    });

    it('should validate authMechanism', function(done) {
      parseConnectionString('mongodb://localhost/?authMechanism=DOGS', err => {
        expect(err).to.exist;
        done();
      });
    });

    it('should validate readPreference', function(done) {
      parseConnectionString('mongodb://localhost/?readPreference=llamasPreferred', err => {
        expect(err).to.exist;
        done();
      });
    });
  });

  function collectTests(path) {
    return fs
      .readdirSync(`${__dirname}/${path}`)
      .filter(x => x.indexOf('.json') !== -1)
      .map(x => JSON.parse(fs.readFileSync(`${__dirname}/${path}/${x}`)));
  }

  describe('spec tests', function() {
    const testFiles = collectTests('../spec/connection-string').concat(
      collectTests('../spec/auth')
    );

    // Execute the tests
    for (let i = 0; i < testFiles.length; i++) {
      const testFile = testFiles[i];

      // Get each test
      for (let j = 0; j < testFile.tests.length; j++) {
        const test = testFile.tests[j];

        it(test.description, {
          metadata: { requires: { topology: 'single' } },
          test: function(done) {
            if (skipTests.indexOf(test.description) !== -1) {
              return this.skip();
            }

            const valid = test.valid;
            parseConnectionString(test.uri, { caseTranslate: false }, function(err, result) {
              if (valid === false) {
                expect(err).to.exist;
                expect(err).to.be.instanceOf(MongoParseError);
                expect(result).to.not.exist;
              } else {
                expect(err).to.not.exist;
                expect(result).to.exist;

                // remove data we don't track
                if (test.auth && test.auth.password === '') {
                  test.auth.password = null;
                }

                if (test.hosts != null) {
                  test.hosts = test.hosts.map(host => {
                    delete host.type;
                    host.host = punycode.toASCII(host.host);
                    return host;
                  });

                  // remove values that require no validation
                  test.hosts.forEach(host => {
                    Object.keys(host).forEach(key => {
                      if (host[key] == null) delete host[key];
                    });
                  });

                  expect(result.hosts).to.containSubset(test.hosts);
                }

                if (test.auth) {
                  if (test.auth.db != null) {
                    expect(result.auth).to.have.property('db');
                    expect(result.auth.db).to.eql(test.auth.db);
                  }

                  if (test.auth.username != null) {
                    expect(result.auth).to.have.property('username');
                    expect(result.auth.username).to.eql(test.auth.username);
                  }

                  if (test.auth.password != null) {
                    expect(result.auth).to.have.property('password');
                    expect(result.auth.password).to.eql(test.auth.password);
                  }
                }

                if (test.options !== null) {
                  // it's possible we have options which are not explicitly included in the spec test
                  expect(result.options).to.deep.include(test.options);
                }
              }

              done();
            });
          }
        });
      }
    }
  });
});
