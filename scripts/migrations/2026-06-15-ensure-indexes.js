/**
 * Ensure MongoDB indexes for calling collections.
 * Run: npm run migrate:indexes
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import SavedContact from '../../src/models/savedContact.model.js';
import Call from '../../src/models/call.model.js';
import CallRecording from '../../src/models/callRecording.model.js';
import CallReport from '../../src/models/callReport.model.js';
import SipEndpoint from '../../src/models/sipEndpoint.model.js';

async function main() {
  const url = process.env.MONGODB_URL;
  if (!url) throw new Error('MONGODB_URL is required');

  await mongoose.connect(url);
  await Promise.all([
    SavedContact.syncIndexes(),
    Call.syncIndexes(),
    CallRecording.syncIndexes(),
    CallReport.syncIndexes(),
    SipEndpoint.syncIndexes(),
  ]);

  console.log('Calling service indexes synced.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
