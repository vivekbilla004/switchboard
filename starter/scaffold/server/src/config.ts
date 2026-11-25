// Every setting comes from the environment. The defaults match the harness,
// so this runs with no .env file. If ../../.env exists it is loaded first.
try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // no .env file: defaults apply
}

const env = (name: string, fallback: string) => process.env[name] ?? fallback;

export const config = {
  port: Number(env('PORT', '4000')),
  webOrigin: env('WEB_ORIGIN', 'http://localhost:5173'),
  graderToken: env('GRADER_TOKEN', 'grader-dev-token'),
  mongoUrl: env('MONGO_URL', 'mongodb://localhost:27017/switchboard'),
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  elasticsearchUrl: env('ELASTICSEARCH_URL', 'http://localhost:9200'),
  pigeon: {
    url: env('PIGEON_URL', 'http://localhost:4010'),
    webhookSecret: env('PIGEON_WEBHOOK_SECRET', 'whsec_pigeon_dev'),
    apiKeys: {
      ws_acme: env('PIGEON_KEY_WS_ACME', 'pk_acme_7d1f0a'),
      ws_globex: env('PIGEON_KEY_WS_GLOBEX', 'pk_globex_c93b22'),
    } as Record<string, string>,
  },
  oidc: {
    issuer: env('OIDC_ISSUER', 'http://localhost:4020'),
    clientId: env('OIDC_CLIENT_ID', 'switchboard-web'),
    clientSecret: env('OIDC_CLIENT_SECRET', 'dev-secret-not-for-production'),
    redirectUri: env('OIDC_REDIRECT_URI', 'http://localhost:4000/auth/callback'),
  },
  paybox: {
    url: env('PAYBOX_URL', 'http://localhost:4030'),
    secretKey: env('PAYBOX_SECRET_KEY', 'sk_test_paybox_51c0de'),
    publishableKey: env('PAYBOX_PUBLISHABLE_KEY', 'pk_test_paybox_9a7b3e'),
    webhookSecret: env('PAYBOX_WEBHOOK_SECRET', 'whsec_paybox_dev'),
  },
};
