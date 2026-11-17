import mongoose from 'mongoose';

// The address without its password, for logs.
export const safeUri = (uri) => String(uri).replace(/\/\/([^:/@]+):[^@/]*@/, '//$1:***@');

export async function connectDB() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/pos_inventory';
  mongoose.set('strictQuery', true);
  // The database may still be starting (e.g. just opened by START-MUMTAZ.bat,
  // a replica set electing its primary): keep trying for about 2 minutes
  // instead of stopping the server on the first refusal.
  const tries = 40;
  for (let i = 1; ; i += 1) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
      break;
    } catch (err) {
      if (i >= tries) throw err;
      console.warn(`[db] not reachable yet (${err.message}) -- trying again in 3 s (${i}/${tries})`);
      await mongoose.disconnect().catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.log(`[db] connected -> ${safeUri(uri)}`);

  mongoose.connection.on('error', (err) => {
    console.error('[db] connection error:', err.message);
  });
}

export default mongoose;
