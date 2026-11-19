const pino = require('pino');

function maskPhone(value) {
  if (typeof value !== 'string' || value.length < 5) return '[REDACTED]';
  return '***' + value.slice(-4);
}

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'api_key', 'apiKey', 'token', 'access_token', 'whatsapp_access_token',
      'authorization', 'password', 'secret', 'dsn', 'facebook_app_secret', 'system_user_access_token',
      'req.headers.authorization', 'req.headers.cookie',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    customerPhone: maskPhone,
    customer_phone: maskPhone,
  },
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

module.exports = logger;
