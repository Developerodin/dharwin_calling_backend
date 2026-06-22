import { randomUUID } from 'crypto';

export default function requestId(req, res, next) {
  req.id = req.get('x-request-id') || randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}
