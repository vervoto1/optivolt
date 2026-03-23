import express from 'express';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { toHttpError } from '../../../api/http-errors.ts';

function coerceHttpError(error) {
  if (
    error &&
    typeof error === 'object' &&
    Number.isInteger(error.statusCode) &&
    typeof error.message === 'string'
  ) {
    return {
      statusCode: error.statusCode,
      message: error.message,
      expose: Boolean(error.expose),
      details: error.details,
    };
  }

  return toHttpError(error);
}

function createRequest(app, { method, url, headers, body }) {
  const req = new Readable({ read() {} });

  req.on = req.on.bind(req);
  req.once = req.once.bind(req);
  req.emit = req.emit.bind(req);
  req.push = req.push.bind(req);
  req.unshift = req.unshift.bind(req);
  req.pause = req.pause.bind(req);
  req.resume = req.resume.bind(req);
  req.pipe = req.pipe.bind(req);
  req.unpipe = req.unpipe.bind(req);
  req.destroy = (() => req).bind(req);
  req._destroy = (_err, cb) => cb(null);

  req.method = method;
  req.url = url;
  req.originalUrl = url;
  req.headers = headers;
  req.connection = {};
  req.socket = req.connection;
  req.app = app;

  Object.setPrototypeOf(req, app.request);

  if (body != null) {
    req.push(body);
  }
  req.push(null);
  return req;
}

function createResponse(app, resolve) {
  const events = new EventEmitter();
  const chunks = [];
  const responseHeaders = new Map();
  const res = {
    locals: {},
    statusCode: 200,
    headersSent: false,
    finished: false,
    on: events.on.bind(events),
    once: events.once.bind(events),
    emit: events.emit.bind(events),
    setHeader(name, value) {
      responseHeaders.set(name.toLowerCase(), value);
      return res;
    },
    getHeader(name) {
      return responseHeaders.get(name.toLowerCase());
    },
    getHeaders() {
      return Object.fromEntries(responseHeaders.entries());
    },
    removeHeader(name) {
      responseHeaders.delete(name.toLowerCase());
    },
    writeHead(statusCode, statusMessage, headers) {
      res.statusCode = statusCode;
      res.headersSent = true;
      if (typeof statusMessage === 'object' && statusMessage != null) {
        headers = statusMessage;
      }
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          res.setHeader(key, value);
        }
      }
      return res;
    },
    write(chunk, encoding, callback) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      }
      if (typeof encoding === 'function') encoding();
      if (typeof callback === 'function') callback();
      return true;
    },
    end(chunk, encoding, callback) {
      if (chunk) {
        res.write(chunk, encoding);
      }
      res.finished = true;
      res.headersSent = true;
      res.emit('finish');
      if (typeof encoding === 'function') encoding();
      if (typeof callback === 'function') callback();
      return res;
    },
  };

  res.app = app;
  Object.setPrototypeOf(res, app.response);

  res.on('finish', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    const contentType = String(res.getHeader('content-type') ?? '');
    let parsedBody = text;
    if (contentType.includes('application/json') && text.length > 0) {
      parsedBody = JSON.parse(text);
    }
    resolve({
      status: res.statusCode,
      body: parsedBody,
      text,
      headers: res.getHeaders(),
    });
  });

  return res;
}

function defaultErrorHandler(err, _req, res, _next) {
  const httpError = coerceHttpError(err);
  const payload = { error: httpError.message };
  if (httpError.expose && httpError.details) {
    payload.details = httpError.details;
  }
  res.status(httpError.statusCode).json(payload);
}

export async function inject(handler, { method = 'GET', url = '/', headers = {}, body, errorHandler = defaultErrorHandler } = {}) {
  const app = express();
  const payload =
    body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const normalizedHeaders = Object.fromEntries(
    Object.entries({
      host: 'localhost',
      ...(payload ? {
        'content-type': 'application/json',
        'content-length': String(payload.length),
      } : {}),
      ...headers,
    }).map(([key, value]) => [key.toLowerCase(), value]),
  );

  return new Promise((resolve, reject) => {
    const req = createRequest(app, { method, url, headers: normalizedHeaders, body: payload });
    const res = createResponse(app, resolve);
    req.res = res;
    res.req = req;

    const stack = [express.json({ limit: '1mb' }), handler, errorHandler];
    let index = 0;

    const next = (err) => {
      const layer = stack[index++];
      if (!layer) {
        if (err) {
          reject(err);
        } else if (!res.finished) {
          reject(new Error(`No response produced for ${method} ${url}`));
        }
        return;
      }

      try {
        if (err) {
          if (layer.length === 4) {
            layer(err, req, res, next);
          } else {
            next(err);
          }
          return;
        }

        if (layer.length === 4) {
          next();
          return;
        }

        const maybePromise = layer(req, res, next);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.catch(next);
        }
      } catch (error) {
        next(error);
      }
    };

    next();
  });
}

export function get(handler, url, options) {
  return inject(handler, { method: 'GET', url, ...options });
}

export function post(handler, url, body, options) {
  return inject(handler, { method: 'POST', url, body, ...options });
}
