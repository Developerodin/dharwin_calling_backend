import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

/**
 * A Twilio phone number provisioned for the org or a specific user.
 *  - Org default number: `isOrgDefault: true`, `user: null`.
 *  - User-owned number: `user` set; a user may own many.
 */
const twilioNumberSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    isOrgDefault: { type: Boolean, default: false, index: true },
    phoneNumber: { type: String, required: true, unique: true, trim: true, index: true },
    sid: { type: String, required: true, unique: true, trim: true },
    friendlyName: { type: String, trim: true, default: '' },
    capabilities: { type: mongoose.Schema.Types.Mixed, default: {} },
    voiceUrl: { type: String, default: '' },
    status: { type: String, default: 'active', index: true }, // active | released
    purchasedAt: { type: Date, default: Date.now },
    releasedAt: { type: Date, default: null },
    providerResponse: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: 'twiliophonenumbers' },
);

twilioNumberSchema.index({ user: 1, status: 1 });

twilioNumberSchema.plugin(toJSON);
twilioNumberSchema.plugin(paginate);

const TwilioNumber = mongoose.model('TwilioNumber', twilioNumberSchema);
export default TwilioNumber;
