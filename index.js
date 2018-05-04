// index.js

// Dependencies
const __ = require('@mediaxpost/lodashext');
const ObjectKeyCache = require('@dealerslink/node-object-key-cache');
const LogStub = require('logstub');

class IPBlacklist {
  constructor(namespace, config, cache, log) {
    const defaults = {
      lookup: [],
      count: 250,
      // 250 request
      expire: 1000 * 60 * 60,
      // every 60 minute window
      whitelist: () => {
        return false;
      },
      onBlacklist: null,
      noip: false
    };

    if (__.isUnset(namespace)) {
      throw new Error('The IP Blacklist cache namespace can not be omitted.');
    }
    this.namespace = namespace;

    this.cache = cache;
    // Default the cache to a memory cache if unset
    if (__.isUnset(this.cache)) {
      this.cache = new ObjectKeyCache();
      this.cache.connect();
    }

    // Default to a logstub if not provided
    this.log = log || new LogStub();

    this.config = __.merge(Object.assign(defaults), config);
  }

  calcLookups(req, res) {
    // check and set lookup
    let looks = [];
    if (typeof this.config.lookup === 'function') {
      looks = this.config.lookup(req, res);
    }

    // Make sure that the lookups are an array if unset
    if (__.hasValue(this.config.lookup)) {
      // Convert to Array if not already
      looks = Array.isArray(this.config.lookup) ? this.config.lookup.splice(0) : [this.config.lookup];
    }

    // Push the IP Address of the requestor into the array
    // This should always be done except when the `noip` flag is true
    if (!this.config.noip) {
      looks.push(req.headers['x-forwarded-for'] || req.connection.remoteAddress);
    }

    // merge lookup options
    return __.join(looks, ':');
  }

  checkWhitelist(req) {
    if (Array.isArray(this.config.whitelist)) {
      const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      return this.config.whitelist.includes(ip);
    }

    if (typeof this.config.whitelist === 'function') {
      return this.config.whitelist(req);
    }

    return false;
  }

  increment(req, res, next, closure) {
    let parsedLimit;

    // Skip if this passes the whitelist
    if (this.checkWhitelist(req)) {
      this.log.debug('Skipping Blacklist Increment -- IP is whitelisted');
      return next ? next() : undefined;
    }

    const lookups = this.calcLookups(req, res);
    const key = `ipblacklist:${lookups}`;
    const timestamp = Date.now();

    const defaultLimit = {
      total: this.config.count,
      remaining: this.config.count,
      reset: timestamp + this.config.expire
    };

    this.cache
      .hgetAsync(this.namespace, key)
      .then((limit) => {
        try {
          parsedLimit = JSON.parse(limit);
        } catch (err) {}
        parsedLimit = parsedLimit || defaultLimit;

        // Check if the blacklist cache has expired and reset if it has
        if (timestamp > parsedLimit.reset) {
          parsedLimit.remaining = this.config.count;
        }

        // another increment moves the expiration window on the requests
        parsedLimit.reset = timestamp + this.config.expire;

        // subtract one from attempts remainins and do not allow negative remaining
        parsedLimit.remaining = Math.max(Number(parsedLimit.remaining) - 1, -1);

        // increment counter
        return this.cache.hsetAsync(this.namespace, key, JSON.stringify(parsedLimit));
      })
      .then(() => {
        // Do nothing
        if (closure) {
          closure();
        }
      })
      .catch((err) => {
        // There was som error trying to retrieve the rate limit cache data
        // Log the error and skip
        this.log.error(err.stack || err);
      });

    return next ? next() : undefined;
  }

  checkBlacklist(req, res, next) {
    let parsedLimit;

    // Skip if this passes the whitelist
    if (this.checkWhitelist(req)) {
      this.log.debug('Skipping Blacklist Check -- IP is whitelisted');
      return next();
    }

    // Set onRateLimited function
    this.config.onBlacklist = typeof this.config.onBlacklist === 'function' ? this.config.onBlacklist : (_req, _res) => {
      // Send an empty 403 response to blacklisted ips
      _res.status(403);
      _res.send(null);
    };

    const lookups = this.calcLookups(req, res);
    const key = `ipblacklist:${lookups}`;
    const timestamp = Date.now();

    const defaultLimit = {
      total: this.config.count,
      remaining: this.config.count,
      reset: timestamp + this.config.expire
    };

    this.cache
      .hgetAsync(this.namespace, key)
      .then((limit) => {
        // No record, skip
        if (!limit) {
          return next();
        }

        try {
          parsedLimit = JSON.parse(limit);
        } catch (err) {}
        parsedLimit = parsedLimit || defaultLimit;

        // Check if the blacklist cache has expired and reset if it has
        if (timestamp > parsedLimit.reset) {
          parsedLimit.reset = timestamp + this.config.expire;
          parsedLimit.remaining = this.config.count;
        }

        if (parsedLimit.remaining >= 0) {
          // Not blacklisted
          return next();
        }

        // Blacklisted
        const after = (parsedLimit.reset - Date.now()) / 1000;
        res.set('Retry-After', after);
        this.config.onBlacklist(req, res, next);
      })
      .catch((err) => {
        // There was som error trying to retrieve the blacklist cache data
        // Log the error and skip
        this.log.error(err.stack || err);
        return next();
      });

    return undefined;
  }
}

module.exports = IPBlacklist;