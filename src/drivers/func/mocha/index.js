const path = require('path');
const Mocha = require('mocha');
const _ = require('lodash');
const axios = require('axios');
const { promisify } = require('util');
const parallel = promisify(require('async/parallel'));
const concat = promisify(require('async/concat'));
const concatSeries = promisify(require('async/concatSeries'));
const config = require('../../../../config');

const utils = require('../../../../libs/utils');

module.exports = {
  get,
  run,
  request,
  case: suite,
  test,
  tests,
  log,
  think,
};

function get(files) {
  const reportDir = Date.now().toString();

  return files.map(file => getMocha(file, reportDir));
}

async function run(tests, isParallel, logStream) {
  await utils.enhanceNativeLogger('func_log.html', logStream);

  const stats = isParallel
    ? await concat(tests, runTest)
    : await concatSeries(tests, runTest);

  utils.resetNativeLogger();

  return formatStats(stats, isParallel);
}

function request(getParams, mock, capture, resource) {
  return async (context = {}) => {
    const params = getParams(context);

    // @todo implement Resource.setResponse
    resource.res = mock
      ? mockRequest(params, mock)
      : await realRequest(params);

    // @todo implement Resource.captureData
    resource.capturedData = utils.captureData(capture, resource.res);

    return resource;
  };
}

function suite(title, actions, tasty) {
  const sets = splitActions(actions);

  Mocha.describe(title, () => {
    if (sets.before.length) {
      Mocha.before(() => tasty.series(...sets.before)());
    }

    if (sets.beforeEach.length) {
      Mocha.beforeEach(() => this.series(...sets.beforeEach)()); // @todo need-tests
    }

    sets.tests.forEach(test => test(tasty)); // @todo question: Maybe call test in tasty context?

    if (sets.afterEach.length) {
      Mocha.afterEach(() => this.series(...sets.afterEach)()); // @todo need-tests
    }

    if (sets.after.length) {
      Mocha.after(() => this.series(...sets.after)()); // @todo need-tests
    }
  });
}

function test (title, request, assertions, tasty) {
  Mocha.it(title, async () => {
    const resource = await request(tasty.context);

    Object.keys(assertions).forEach(assertion => {
      resource[assertion](assertions[assertion], tasty.context);
    });
  });
}

function tests (title, suites, request, assertions, isParallel, tasty) {
  if (isParallel) {
    let responses = [];

    Mocha.before(async () => {
      responses = await parallel(suites.map(suite => (
        async () => request({
          ...tasty.context,
          suite,
        })
      )));
    });

    suites.forEach((suite, i) => {
      Mocha.it(utils.evalTpl(title, { suite }), () => {
        Object.keys(assertions).forEach(key => {
          const assertion = typeof assertions[key] === 'string'
            ? utils.evalTpl(assertions[key], { suite })
            : assertions[key];

          responses[i][key](assertion, { suite });
        });
      });
    });
  } else {
    suites.forEach((suite) => {
      Mocha.it(utils.evalTpl(title, { suite }), async () => {
        const resource = await request({
          ...tasty.context,
          suite,
        });

        Object.keys(assertions).forEach(key => {
          const assertion = typeof assertions[key] === 'string'
            ? utils.evalTpl(assertions[key], { suite })
            : assertions[key];

          resource[assertion](key, { suite });
        });
      });
    });
  }
}

function log() {
  // @todo implement logging tests
}

function think(seconds) {
  // @todo implement pausing tests
}

function getMocha(file, reportDir) {
  resetCache(file);
  const fileName = file.slice(_.lastIndexOf(file, '/') + 1, -3);
  const _cfg = require(config.get('func_cfg'));
  const cfg = {
    reporterOptions: {
      reportDir: path.join(_.get(_cfg, 'reporterOptions.reportDir'), reportDir, fileName),
    }
  };

  const mocha = new Mocha(_.merge({}, _cfg, cfg));

  return mocha.addFile(path.resolve(file));
}

function runTest(test, cb) {
  const runner = test.run(() => {
    cb(null, runner.stats);
  });
}

function formatStats(stats, isParallel) {
  const res = {
    start: _.get(stats, '[0].start', 0),
    end: isParallel ? null : _.get(stats, `[${stats.length - 1}].end`, 0),
    suites: 0,
    tests: 0,
    passes: 0,
    pending: 0,
    failures: 0,
    duration: 0,
  };

  stats.forEach((stat) => {
    res.suites += _.get(stat, 'suites', 0);
    res.tests += _.get(stat, 'tests', 0);
    res.passes += _.get(stat, 'passes', 0);
    res.pending += _.get(stat, 'pending', 0);
    res.failures += _.get(stat, 'failures');

    if (isParallel) {
      res.end = _.get(stat, 'duration', 0) > res.duration ? _.get(stat, 'end', 0) : res.end;
      res.duration = _.get(stat, 'duration', 0) > res.duration ? _.get(stat, 'duration', 0) : res.duration;
    } else {
      res.duration += _.get(stat, 'duration', 0);
    }
  });

  res.duration += 'ms';

  return res;
}

function mockRequest(params, mock) {
  return {
    data: mock,
  };
}

async function realRequest(params) {
  try {
    return await axios({
      method: params.method,
      url: params.url,
      headers: params.headers,
      params: params.params,
      data: params.body,
    });
  } catch (err) {
    return err.response;
  }
}

/**
 * @function splitActions - Split action on three five groups
 * @param {function[]} actions - Tests actions
 * @returns {object} - Object with actions' groups
 */
function splitActions(actions) {
  return actions.reduce((sets, action) => {
    if (typeof action === 'function' && (action.name === 'test' || action.name === 'tests')) {
      sets.tests.push(action);

      return sets;
    }

    if (sets.tests.length) {
      if (Array.isArray(action)) {
        sets.afterEach.push(action);
      } else {
        sets.after.push(action);
      }

      return sets;
    }

    if (Array.isArray(action)) {
      sets.beforeEach.push(action);
    } else {
      sets.before.push(action);
    }

    return sets;
  }, {
    before: [],
    beforeEach: [],
    after: [],
    afterEach: [],
    tests: [],
  });
}

function resetCache(testModule) {
  if (require.cache[path.resolve(testModule)]) {
    delete require.cache[path.resolve(testModule)];
  }
}