import mongoose from 'mongoose';

// Used to generate gap-free, human-readable sequential numbers
// (receipt numbers, purchase numbers) via atomic findOneAndUpdate increments.
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.model('Counter', counterSchema);

export async function nextSequence(name, session = null) {
  const doc = await Counter.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session }
  );
  return doc.seq;
}

// Reserves `count` numbers at once; returns the one before the first (so the
// caller uses base + 1 .. base + count).
export async function nextSequenceBlock(name, count, session = null) {
  const doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: count } }, { new: true, upsert: true, session });
  return doc.seq - count;
}

export default Counter;
