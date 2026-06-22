import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

export const TERMINAL_STATUSES = ['completed', 'failed', 'busy', 'no_answer', 'canceled', 'rejected'];

export const STATUS_RANK = {
  unknown: 0,
  queued: 1,
  initiated: 1,
  ringing: 2,
  in_progress: 3,
  completed: 10,
  failed: 10,
  busy: 10,
  no_answer: 10,
  canceled: 10,
  rejected: 10,
};

export function rankOf(status) {
  if (!status) return 0;
  return STATUS_RANK[String(status).toLowerCase()] ?? 0;
}

export function isTerminal(status) {
  if (!status) return false;
  return TERMINAL_STATUSES.includes(String(status).toLowerCase());
}

const callSchema = new mongoose.Schema(
  {
    callSid: { type: String, required: true, unique: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    contact: { type: mongoose.Schema.Types.ObjectId, ref: 'SavedContact', default: null, index: true },
    callerNumber: { type: String, trim: true, default: '' },
    receiverNumber: { type: String, trim: true, default: '' },
    direction: { type: String, enum: ['inbound', 'outbound'], default: 'outbound', index: true },
    mode: { type: String, enum: ['client', 'server'], default: 'server', index: true },
    status: { type: String, default: 'initiated', index: true },
    statusRank: { type: Number, default: 1, index: true },
    statusUpdatedAt: { type: Date, default: Date.now, index: true },
    muted: { type: Boolean, default: false },
    recordingActive: { type: Boolean, default: false },
    duration: { type: Number, default: 0 },
    callStartTime: { type: Date, default: null },
    callEndTime: { type: Date, default: null },
    recordingUrl: { type: String, default: null },
    recordingDuration: { type: Number, default: null },
    recordingSid: { type: String, default: null, index: true },
    errorMessage: { type: String, default: null },
    providerResponse: { type: mongoose.Schema.Types.Mixed, default: {} },
    twilioResponse: { type: mongoose.Schema.Types.Mixed, default: undefined },
    source: { type: String, enum: ['api', 'webhook'], default: 'api' },
    reportGenerated: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'plivocalls' }
);

callSchema.index({ user: 1, createdAt: -1 });
callSchema.index({ status: 1, createdAt: -1 });

callSchema.options.toJSON = {
  ...(callSchema.options.toJSON || {}),
  transform(_doc, ret, options) {
    if (!ret.providerResponse && ret.twilioResponse) {
      ret.providerResponse = ret.twilioResponse;
    }
    if (ret.providerResponse) {
      ret.twilioResponse = ret.providerResponse;
    }
    return ret;
  },
};

callSchema.plugin(toJSON);
callSchema.plugin(paginate);

const Call = mongoose.model('Call', callSchema);
export default Call;
