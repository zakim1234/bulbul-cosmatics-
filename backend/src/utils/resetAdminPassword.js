import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from '../config/db.js';
import User from '../models/User.js';
import { MIN_PASSWORD_LENGTH, setPassword } from './password.js';
import { normalizeEmail } from './email.js';

// Sets a new password for an existing user (default: admin) and makes sure the
// account is active. For when the password is forgotten. It asks for the new
// password (hidden, typed twice), the same on Windows and on Linux:
//   npm run reset:admin              -> the user "admin"
//   npm run reset:admin -- cali@example.com   -> that user (their email,
//                                               or old username)
// Without a terminal (scripts), RESET_PASSWORD (and RESET_USERNAME) give it.

// Reads a line from the terminal without showing what is typed.
function askHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return Promise.reject(new Error('Run this in a terminal to type the password (or set RESET_PASSWORD).'));
  }
  return new Promise((resolve) => {
    let value = '';
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (c === '\u0003') {
          // Ctrl+C
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function newPassword() {
  if (process.env.RESET_PASSWORD) return process.env.RESET_PASSWORD;
  const first = await askHidden(`New password (at least ${MIN_PASSWORD_LENGTH} characters): `);
  if (first.length < MIN_PASSWORD_LENGTH) throw new Error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  const again = await askHidden('Type it again: ');
  if (again !== first) throw new Error('The two passwords are not the same. Nothing was changed.');
  return first;
}

// `--email new@example.com` also gives the user that email to sign in with
// (for users from before emails):
//   npm run reset:admin -- admin --email admin@example.com
function parseArgs(argv) {
  const args = [...argv];
  let email;
  const at = args.indexOf('--email');
  if (at !== -1) {
    email = args[at + 1];
    if (!email) throw new Error('Write the email after --email.');
    args.splice(at, 2);
  }
  return { who: args[0], email };
}

async function resetPassword() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required (backend/.env).');
  const { who, email: wantedEmail } = parseArgs(process.argv.slice(2));
  const username = String(who || process.env.RESET_USERNAME || 'admin').trim().toLowerCase();
  const email = wantedEmail === undefined ? undefined : normalizeEmail(wantedEmail);

  await connectDB();
  const user = await User.findOne({ username });
  if (!user) {
    const names = (await User.find({}, { username: 1 }).lean()).map((u) => u.username);
    throw new Error(`No user "${username}". Users: ${names.join(', ') || 'none'}`);
  }
  if (email && email !== user.username && (await User.exists({ username: email }))) {
    throw new Error(`The email ${email} is already used by another user. Nothing was changed.`);
  }
  const password = await newPassword();
  await setPassword(user, password); // signs out everyone using the old password
  if (email) user.username = email;
  user.active = true;
  await user.save();
  console.log(`Password changed for "${user.username}". You can sign in now${email ? ` with ${email}` : ''}.`);
}

resetPassword()
  .catch((error) => {
    console.error('Password reset failed:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
