'use strict';

const jwt = require('jsonwebtoken');
const isIp = require('is-ip');

/**
 * BigCommerce OAuth2 Authentication and API access
 *
 * @param {Object} config
 * @return null
 *
 * Example Config
 * {
 *   logLevel: 'info',
 *   clientId: 'hjasdfhj09sasd80dsf04dfhg90rsds',
 *   secret: 'odpdf83m40fmxcv0345cvfgh73bdwjc',
 *   callback: 'https://mysite.com/bigcommerce'
 *   accessToken: 'ly8cl3wwcyj12vpechm34fd20oqpnl',
 *   storeHash: 'x62tqn',
 *   responseType: 'json',
 *   headers: { 'Accept-Encoding': '*' }
 * }
 */

const logger = require('debug')('node-bigcommerce:bigcommerce'),
  crypto = require('crypto'),
  Request = require('./request');

class BigCommerce {
  constructor(config) {
    if (!config) {
      throw new Error(
        'Config missing. The config object is required to make any call to the ' +
        'BigCommerce API'
      );
    }

    this.config = config;
    this.apiVersion = this.config.apiVersion || 'v2';
  }

  /** Verify legacy signed_payload (can be ignored in favor of JWT) **/
  verify(signedRequest) {
    if (!signedRequest) {
      throw new Error('The signed request is required to verify the call.');
    }

    const splitRequest = signedRequest.split('.');
    if (splitRequest.length < 2) {
      throw new Error(
        'The signed request will come in two parts seperated by a .(full stop). ' +
        'this signed request contains less than 2 parts.'
      );
    }

    const signature = Buffer.from(splitRequest[1], 'base64').toString('utf8');
    const json = Buffer.from(splitRequest[0], 'base64').toString('utf8');
    const data = JSON.parse(json);

    logger('JSON: ' + json);
    logger('Signature: ' + signature);

    const expected = crypto.createHmac('sha256', this.config.secret)
      .update(json)
      .digest('hex');

    logger('Expected Signature: ' + expected);

    if (
      expected.length !== signature.length ||
      !crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'))
    ) {
      throw new Error('Signature is invalid');
    }

    logger('Signature is valid');
    return data;
  }

  /** Verify signed_payload_jwt from load callback or constructed from constructJwtFromAuthData
   * @param signedRequestJwt
   * @returns object
   */
  verifyJWT(signedRequestJwt) {
    return jwt.verify(signedRequestJwt, this.config.secret, {
      algorithms: ['HS256'],
      audience: this.config.client_id
    });
  }

  /** Construct a JWT mimicking the format of the load callback from the auth callback data
   * to use in an app
   * (to minimize duplication of code related to handling callbacks)
   * callbacks
   * @param user
   * @param context
   * @param url
   * @returns string
   */
  constructJWTFromAuthData(user, context, url) {
    return jwt.sign({
      aud: this.config.client_id,
      iss: this.config.client_id,
      sub: context,
      user,
      owner: user,
      url: url || '/'
    }, this.config.secret, { expiresIn: '24h', algorithm: 'HS256' });
  }

  /** Construct a JWT for customer login https://developer.bigcommerce.com/api-docs/storefront/customer-login-api
   * @param customerId
   * @param channelId
   * @param options
   * @returns string
   */
  createCustomerLoginJWT(customerId, channelId = 1, options = {}) {
    const payload = {
      iss: this.config.clientId,
      operation: 'customer_login',
      store_hash: this.config.storeHash,
      customer_id: customerId,
      channel_id: channelId,
      jti: crypto.randomBytes(32).toString('hex')
    };

    /* Optional redirect URL (relative path on the storefront), e.g. '/shop-all/' */
    if (options.redirectUrl) {
      payload.redirect_url = options.redirectUrl;
    }

    /*
    * Optional end-user IP for extra security
    * The login will be rejected if it does not come from this IP
    */
    if (options.requestIP) {
      if (!isIp(options.requestIP)) {
        throw new Error('Invalid IP address');
      }
      payload.request_ip = options.requestIP;
    }

    /*
     * Run an API request to get the current server time from BC to use for the JWT generation
     * This is useful to prevent clock skew resulting in invalid JWTs
     */
    if (options.useBCTime) {
      payload.iat = this.getTime();
    } else {
      payload.iat = Math.floor(Date.now() / 1000);
    }

    return jwt.sign(payload, this.config.secret, { expiresIn: '24h', algorithm: 'HS256' });
  }

  async authorize(query) {
    if (!query) throw new Error('The URL query paramaters are required.');

    const payload = {
      client_id: this.config.clientId,
      client_secret: this.config.secret,
      redirect_uri: this.config.callback,
      grant_type: 'authorization_code',
      code: query.code,
      scope: query.scope,
      context: query.context
    };

    const loginUrl = this.config.loginUrl || 'login.bigcommerce.com';

    const request = new Request(loginUrl, {
      failOnLimitReached: this.config.failOnLimitReached
    });

    return await request.run('post', '/oauth2/token', payload);
  }

  createAPIRequest() {
    const accept = this.config.responseType === 'xml' ? 'application/xml' : 'application/json';

    const apiUrl = this.config.apiUrl || 'api.bigcommerce.com';

    return new Request(apiUrl, {
      headers: Object.assign({
        Accept: accept,
        'X-Auth-Client': this.config.clientId,
        'X-Auth-Token': this.config.accessToken
      }, this.config.headers || {}),
      failOnLimitReached: this.config.failOnLimitReached,
      agent: this.config.agent
    });
  }

  async request(type, path, data) {
    if (!this.config.accessToken || !this.config.storeHash) {
      throw new Error(
        'Get request error: the access token and store hash are required to ' +
        'call the BigCommerce API'
      );
    }

    const extension = this.config.responseType === 'xml' ? '.xml' : '';
    const version = this.apiVersion;

    const request = this.createAPIRequest();

    let fullPath = `/stores/${this.config.storeHash}/${version}`;
    if (version !== 'v3') {
      fullPath += path.replace(/(\?|$)/, extension + '$1');
    } else {
      fullPath += path;
    }

    return await request.run(type, fullPath, data);
  }

  getTime() {
    const request = this.createAPIRequest();

    return request.run('GET', `/stores/${this.config.storeHash}/v2/time`).time;
  }

  async get(path) {
    return await this.request('get', path);
  }

  async post(path, data) {
    return await this.request('post', path, data);
  }

  async put(path, data) {
    return await this.request('put', path, data);
  }

  async delete(path) {
    return await this.request('delete', path);
  }
}

module.exports = BigCommerce;
