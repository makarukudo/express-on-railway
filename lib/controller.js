var cache = {}, layoutsCache = {}, fs = require('fs'),
    path        = require('path'),
    // import railway utils
    utils       = require('./railway_utils'),
    safe_merge  = utils.safe_merge,
    camelize    = utils.camelize,
    classify    = utils.classify,
    underscore  = utils.underscore,
    singularize = utils.singularize,
    pluralize   = utils.pluralize,
    $           = utils.stylize.$,
    log         = utils.debug,
    runCode     = utils.runCode;

var IS_NODE_04 = process.versions.node < '0.6';

var id = 0;

/**
 * Controller encapsulates http request handling layer. It allows to 
 * render response, redirect, and tons of other related stuff.
 *
 * Instance of controller is actual response handler, it's not a 
 * like in RoR, you can not inherit controllers, just load, mix.
 *
 * Inheritance in controllers is bad idea.
 *
 * @param {String} name - name of controller
 */
function Controller(name) {
    var self = this;
    this.id = ++id;
    this._beforeFilters = [];
    this._afterFilters = [];
    this._actions = {};
    this._layout = null;

    if (!layoutsCache[name]) {
        // TODO: what if view engine name differs from extension?
        layoutsCache[name] = path.existsSync(app.root + '/app/views/layouts/' + name + '_layout.' + app.settings['view engine']) ? name : 'application';
    }

    var baseLayout = this._layout = layoutsCache[name];

    // allow to disable layout by default for all views
    // using app.settings['view options'].layout = false
    if ((app.set('view options') || {}).layout === false) {
        baseLayout = false;
    }

    this.controllerName = name;
    this.controllerFile = Controller.index[name];

    if (!this.controllerFile) {
        throw new Error('Controller ' + name + ' is not defined');
    }

    // import outer context
    if (Controller.context[name]) {
        Object.keys(Controller.context[name]).forEach(function (key) {
            this[key] = Controller.context[name][key];
        }.bind(this));
    }

    this.__dirname = app.root;

    /*
     * Need to store name of filter to be able to skip it
     */
    function filter(args) {
        if (typeof args[0] === 'string' && typeof args[1] === 'function') {
            // change order
            args[1].customName = args[0];
            return [args[1], args[2], args[0]];
        } else {
            // normal order
            args[0].customName = args[0].name;
            return [args[0], args[1], args[0].name];
        }
    }

    this.skipBeforeFilter = function (name, only) {
        this._beforeFilters.forEach(function (filter, i) {
            if (filter[0] && filter[0].customName && name === filter[0].customName) {
                skipFilter(this._beforeFilters, i, only ? only.only : null);
            }
        }.bind(this));
    };

    this.skipAfterFilter = function (name, only) {
        this._afterFilters.forEach(function (filter, i) {
            if (filter[0] && filter[0].customName && name === filter[0].customName) {
                skipFilter(this._afterFilters, i, only ? only.only : null);
            }
        }.bind(this));
    };

    function skipFilter(filters, index, only) {
        if (!only) {
            delete filters[index];
        } else if (filters[index][1]) {
            if (!filters[index][1].except) {
                filters[index][1].except = [];
            } else if (typeof filters[index][1].except === 'string') {
                filters[index][1].except = [filters[index][1].except];
            }
            if (typeof only === 'string') {
                filters[index][1].except.push(only);
            } else if (only && only.forEach) {
                only.forEach(function (name) {
                    filters[index][1].except.push(name);
                });
            }
        }
    }

    var filterParams = ['password'];
    Controller.prototype.filterParameterLogging = function (args) {
        filterParams = filterParams.concat(Array.prototype.slice.call(arguments));
    };

    if (!IS_NODE_04) {
        this.__defineGetter__('response',  function () { return this.ctx.res }.bind(this));
        this.__defineGetter__('res',       function () { return this.ctx.res }.bind(this));
        this.__defineGetter__('request',   function () { return this.ctx.req }.bind(this));
        this.__defineGetter__('req',       function () { return this.ctx.req }.bind(this));
        this.__defineGetter__('session',   function () { return this.ctx.req.session }.bind(this));
        this.__defineGetter__('params',    function () { return this.ctx.req.params }.bind(this));
        this.__defineGetter__('body',      function () { return this.ctx.req.body }.bind(this));
        this.__defineGetter__('next',      function () { return this.ctx.next }.bind(this));
        this.__defineGetter__('actionName',function () { return this.ctx.action }.bind(this));
        this.__defineGetter__('path_to',   function () { return this.ctx.paths }.bind(this));
    }

    this.t = T();
    this.t.locale = app.settings.defaultLocale || 'en';
    this.T = T;

    if (process.cov && !this.__cov) {
        this.__cov = __cov;
    }

    this.perform = function (actionName, req, res) {
        res.info = {
            controller: this.controllerName,
            action: actionName,
            startTime: Date.now()
        };
        res.actionHistory = [];
        if (!this.initialized) {
            this.initialized = true;
            if (IS_NODE_04) {
                this.actionName = actionName;
                this.request = this.req = req;
                this.request.sandbox = {};
                this.response = this.res = res;
                this.params = req.params;
                this.session = res.session;
                this.body = req.body;
                this.next = next;
                this.path_to = Controller.getPathTo(actionName, req, res);
            }
            this.init();
        }

        var ctl = this, timeStart = false, prevMethod;

        // need to track uniqueness of filters by name
        var queueIndex = {};

        this.ctx = {
            req: req,
            res: res,
            next: next,
            action: actionName,
            paths: Controller.getPathTo(actionName, req, res)
        };

        req.sandbox = {};

        log('');
        log($((new Date).toString()).yellow + ' ' + $(this.id).bold);
        log($(req.method).bold, $(req.url).grey, 'controller:', $(this.controllerName).green, 'action:', $(this.actionName).blue);

        if (Object.keys(req.query).length) {
            log($('Query: ').bold + JSON.stringify(req.query));
        }
        if (req.body && req.method !== 'GET') {
            var filteredBody = {};
            Object.keys(req.body).forEach(function (param) {
                if (!filterParams.some(function (filter) {return param.search(filter) !== -1;})) {
                    filteredBody[param] = req.body[param];
                } else {
                    filteredBody[param] = '[FILTERED]';
                }
            });
            log($('Body:  ').bold + JSON.stringify(filteredBody));
        }

        var queue = [];

        enqueue(this._beforeFilters, queue);
        queue.push(getCaller(this._actions[actionName]));
        enqueue(this._afterFilters, queue);

        if (app.disabled('model cache')) {
            // queue.push(getCaller(app.disconnectSchemas));
        }
        if (app.enabled('eval cache')) {
            queue.push(getCaller(function () {
                backToPool(ctl);
            }));
        }

        next();

        var logActions = app.enabled('log actions');

        function next() {

            if (logActions && timeStart && prevMethod) {
                log('<<< ' + prevMethod.customName + ' [' + (Date.now() - timeStart) + ' ms]');
            }

            if (timeStart && prevMethod) {
                res.actionHistory.push({name: prevMethod.customName, time: Date.now() - timeStart});
            }

            // run next method in queue (if any callable method)
            var method = queue.shift();
            if (typeof method == 'function') {
                process.nextTick(function () {
                    method.call(ctl.request.sandbox, next);
                });
            } else {
                res.info.appTime = Date.now() - res.info.startTime;
            }
        }

        function getCaller(method) {
            if (!method) {
                throw new Error('Undefined action');
            }

            return function (next) {
                req.inAction = method.isAction;
                if (logActions && method.customName) {
                    if (method.isAction) {
                        log('>>> perform ' + $(method.customName).bold.blue);
                    } else {
                        log('>>> perform ' + $(method.customName).bold.grey);
                    }
                }
                timeStart = Date.now();
                prevMethod = method;
                method.call(this, next);
            }
        }

        function enqueue(collection, queue) {
            collection.forEach(function (f) {
                var params = f[1];
                if (!params) {
                    enqueue();
                } else if (params.only && params.only.indexOf(actionName) !== -1 && (!params.except || params.except.indexOf(actionName) === -1)) {
                    enqueue();
                } else if (params.except && params.except.indexOf(actionName) === -1) {
                    enqueue();
                }
                function enqueue() {
                    if (f[2]) {
                        if (queueIndex[f[2]]) return;
                        queueIndex[f[2]] = true;
                    }
                    queue.push(getCaller(f[0]));
                }
            });
        }
    };

    var buffer = {};
    this.publish = function (name, obj) {
        if (typeof name !== 'function' && typeof name.name === 'string') {
            obj = name;
            name = obj.name;
        }
        buffer[name] = obj;
    };

    this.use = function (name) {
        return buffer[name];
    };

    this.init = function () {
        // reset scope variables
        this._actions = {};
        this._beforeFilters = [];
        this._afterFilters = [];
        buffer = {};
        this._layout = baseLayout;

        // publish models
        if (app.models) {
            Object.keys(app.models).forEach(function (className) {
                this[className] = app.models[className];
            }.bind(this));
        }

        Object.keys(Controller.prototype).forEach(function (method) {
            this[method] = Controller.prototype[method];
        }.bind(this));

        runCode(this.controllerFile, this);
    };

}

/**
 * Define controller action
 *
 * @param name String - optional (if missed, named function required as first param)
 * @param action Funcion - required, should be named function if first arg missed
 *
 * @example
 * ```
 * action(function index() {
 *     Post.all(function (err, posts) {
 *         render({posts: posts});
 *     });
 * });
 * ```
 *
 */
Controller.prototype.action = function (name, action) {
    if (typeof name === 'function') {
        action = name;
        name = action.name;
        if (!name) {
            throw new Error('Named function required when `name` param omitted');
        }
    }
    action.isAction = true;
    action.customName = name;
    this._actions[name] = action;
};

/**
 * Layout setter/getter
 *
 * when called without arguments, used as getter,
 * when called with string, used as setter
 *
 * @param {String} layout - [optional] layout name
 */
Controller.prototype.layout = function layout(l) {
    if (typeof l !== 'undefined') {
        this._layout = l;
    }
    return this._layout ? this._layout + '_layout' : null;
};


function filter(args) {
    if (typeof args[0] === 'string' && typeof args[1] === 'function') {
        // change order
        args[1].customName = args[0];
        return [args[1], args[2], args[0]];
    } else {
        // normal order
        args[0].customName = args[0].name;
        return [args[0], args[1], args[0].name];
    }
}

/**
 * Schedule before filter to the end of queue
 *
 * @alias beforeFilter
 * @param {Funcion} f
 * @param {Object} params
 */
Controller.prototype.before = function before(f, params) {
    this._beforeFilters.push(filter(arguments));
};
Controller.prototype.beforeFilter = Controller.prototype.before;

/**
 * Schedule before filter to the start of queue
 *
 * @alias prependBeforeFilter
 * @param {Funcion} f
 * @param {Object} params
 */
Controller.prototype.prependBefore = function prependBefore(f, params) {
    this._beforeFilters.unshift(filter(arguments));
};
Controller.prototype.prependBeforeFilter = Controller.prototype.prependBefore;

/**
 * @override default controller string representation
 */
Controller.prototype.toString = function toString() {
    return 'Controller ' + this.controllerName;
};

/**
 * @param {String} name - name of action
 * @returns whether controller responds to action
 */
Controller.prototype.respondTo = function respondTo(name) {
    return typeof this._actions[name] == 'function';
};

/**
 * Append after filter to the end of queue
 */
Controller.prototype.after = function after(f, params) {
    this._afterFilters.push(filter(arguments));
};
Controller.prototype.afterFilter = Controller.prototype.after;

/**
 * Prepend after filter to the start of queue
 */
Controller.prototype.prependAfter = function prependAfter(f, params) {
    this._afterFilters.unshift(filter(arguments));
};
Controller.prototype.prependAfterFilter = Controller.prototype.prependAfter;

/**
 * Set current locale
 */
Controller.prototype.setLocale = function (locale) {
    this.t.locale = T.localeSupported(locale) ? locale : app.settings.defaultLocale;
};

/**
 * Get current locale
 */
Controller.prototype.getLocale = function () {
    return this.t.locale;
};

/**
 * Load another controller code in this context
 * @param {String} controller - name of controller (without _controller suffix)
 */
Controller.prototype.load = function (controller) {
    var ctl = Controller.index[controller];
    if (!ctl) {
        throw new Error('Controller ' + controller + ' is not defined. Please note that namespaced controllers names should include namespace when loading');
    }
    runCode(ctl, this);
};

/**
 * Send response
 */
Controller.prototype.send = function (x) {
    log('Send to client: ' + x);
    this.response.send.apply(this.response, Array.prototype.slice.call(arguments));
    if (this.request.inAction) this.next();
};

/**
 * Redirect to `path`
 */
Controller.prototype.redirect = function (path) {
    log('Redirected to', $(path).grey);
    this.response.redirect(path.toString());
    if (this.request.inAction) this.next();
};

/**
 * Render html response
 */
Controller.prototype.render = function (arg1, arg2) {
    var view, params;
    if (typeof arg1 == 'string') {
        view = arg1;
        params = arg2;
    } else {
        // console.log(params);
        view = this.actionName;
        params = arg1;
    }
    params = params || {};
    params.controllerName = params.controllerName || this.controllerName;
    params.actionName = params.actionName || this.actionName;
    params.path_to = this.path_to;
    params.request = this.request;
    params.t = this.t;
    var layout = this.layout(),
        file = this.controllerName + '/' + view;

    if (this.response.renderCalled) {
        log('Rendering', $(file).grey, 'using layout', $(layout).grey, 'called twice.', $('render() can be called only once!').red);
        return;
    }

    var helper;
    try {
        helper = require(app.root + '/app/helpers/' + this.controllerName + '_helper');
    } catch (e) {
        helper = {};
    }

    var appHelper;
    try {
        appHelper = require(app.root + '/app/helpers/application_helper');
    } catch (e) {
        appHelper = {};
    }

    log('Rendering', $(file).grey, 'using layout', $(layout).grey);

    var helpers = railway.helpers.personalize(this);

    this.response.renderCalled = true;
    this.response.render(file, {
        locals: safe_merge(params, this.request.sandbox, this.path_to, helpers, helpers.__proto__, helper, appHelper),
        layout: layout ? 'layouts/' + layout : false,
        debug:  false
    });
    if (this.request.inAction) this.next();
};

/**
 * Add flash error to display in next request
 *
 * @param {String} type
 * @param {String} message
 */
Controller.prototype.flash = function (type, message) {
    this.request.flash.apply(this.request, Array.prototype.slice.call(arguments));
};

var pool = {};
function backToPool(ctl) {
    pool[ctl.controllerName].push(ctl);
}
exports.load = function (name) {
    if (app.disabled('eval cache')) {
        return new Controller(name);
    } else {
        if (!pool[name]) pool[name] = [];
        var ctl = pool[name].shift();
        if (!ctl) {
            // console.log('new controller');
            ctl = new Controller(name);
        }
        return ctl;
    }
};

Controller.getPathTo = function (actionName, req, res) {
    return railway.routeMapper.pathTo;
};

/**
 * Add custom base controller dir to railway pool. It allows you to build
 * extensions with your own controllers, and build app
 * breaken by modules
 *
 * @param {String} basePath
 * @param {String} prefix
 * @param {Object} context - controller context tweaks, all members of
 * this object will be accesible in controller
 *
 * @public railway.controller.addBasePath
 */
function addBasePath(basePath, prefix, context) {
    prefix = prefix || '';
    if (path.existsSync(basePath)) {
        fs.readdirSync(basePath).forEach(function (file) {
            var stat = fs.statSync(path.join(basePath, file));
            if (stat.isFile()) {
                var m = file.match(/(.*?)_controller\.(js|coffee)$/);
                if (m) {
                    var ctl = prefix + m[1];
                    Controller.index[ctl] = Controller.index[ctl] || path.join(basePath, file);
                    Controller.context[ctl] = Controller.context[ctl] || context;
                }
            } else if (stat.isDirectory()) {
                exports.addBasePath(path.join(basePath, file), prefix + file + '/');
            }
        });
    }
};
exports.addBasePath = addBasePath;

exports.Controller = Controller;

exports.init = function () {
    cache = {};
    Controller.index = {};
    Controller.context = {};
    exports.addBasePath(app.root + '/app/controllers');
};

/**
 * Enables CSRF Protection
 *
 * This filter will check `authenticity_token` param of POST request 
 * and compare with token calculated by session token and app-wide secret
 *
 * @param {String} secret
 * @param {String} paramName
 *
 * @example `app/controllers/application_controller.js`
 * ```
 * before('protect from forgery', function () {
 *     protectFromForgery('415858f8c3f63ba98546437f03b5a9a4ddea301f');
 * });
 * ```
 */
Controller.prototype.protectFromForgery = function protectFromForgery(secret, paramName) {
    var req = this.request;

    if (!req.session) {
        return this.next();
    }

    if (!req.session.csrfToken) {
        req.session.csrfToken = Math.random();
        req.csrfParam = paramName || 'authenticity_token';
        req.csrfToken = sign(req.session.csrfToken);
        return this.next();
    }

    // publish secure credentials
    req.csrfParam = paramName || 'authenticity_token';
    req.csrfToken = sign(req.session.csrfToken);

    if (req.originalMethod == 'POST') {
        var token = req.param('authenticity_token');
        if (!token || token !== sign(req.session.csrfToken)) {
            railway.logger.write('Incorrect authenticity token');
            this.send(403);
        } else {
            this.next();
        }
    } else {
        this.next();
    }

    function sign(n) {
        return require('crypto').createHash('sha1').update(n.toString()).update(secret.toString()).digest('hex');
    }
};

Controller.prototype.protectedFromForgery = function () {
    return this.request.csrfToken && this.request.csrfParam;
};
