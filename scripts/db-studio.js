import 'dotenv/config';
import { spawn } from 'node:child_process';

const url = new URL(process.env.DATABASE_URL);
url.hostname = 'localhost'; // reach Postgres via the port published in docker-compose.dev.yml

spawn('npx', ['prisma', 'studio', '--port', '5555', '--browser', 'none'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: url.toString() },
});