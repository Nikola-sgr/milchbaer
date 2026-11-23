/*
 * Milchbär – Konfiguration.
 * PUSH_API_URL: Adresse des Erinnerungs-Backends (Cloudflare Worker).
 * VAPID_PUBLIC_KEY: öffentlicher Web-Push-Schlüssel (der private liegt nur als Secret beim Worker).
 */
(function (root) {
  'use strict';
  const host = root.location ? root.location.hostname : '';
  const local = host === 'localhost' || host === '127.0.0.1';
  root.MB = root.MB || {};
  root.MB.config = {
    VERSION: '1.0.0',
    PUSH_API_URL: local ? 'http://localhost:8787' : 'https://milchbaer-push.milchbaer-push.workers.dev',
    VAPID_PUBLIC_KEY: 'BFvi-GnxIVAbGfo6EsLjJTHhVLin07Of6HADsOw_o_ldGCdB1H8O9D2uV22f1-Qa3YcDcpZwMopwthk6Jc1YyHU',
  };
})(typeof self !== 'undefined' ? self : globalThis);
