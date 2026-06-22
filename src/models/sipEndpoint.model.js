import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const sipEndpointSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    username: { type: String, required: true, unique: true, index: true },
    password: { type: String, required: true },
    endpointId: { type: String, default: null, index: true },
    alias: { type: String, default: '' },
    phoneNumber: { type: String, trim: true, default: '', index: true },
    appId: { type: String, default: null },
    providerResponse: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: 'plivosipendpoints' }
);

sipEndpointSchema.plugin(toJSON);

const SipEndpoint = mongoose.model('SipEndpoint', sipEndpointSchema);
export default SipEndpoint;
