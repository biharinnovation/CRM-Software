import dotenv from "dotenv";
dotenv.config();

const config = {
  env: process.env.NODE_ENV || "development",
  port: parseInt(process.env.PORT, 10) || 5000,

  db: {
    url: process.env.DATABASE_URL,
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || "access-secret-change-me",
    refreshSecret: process.env.JWT_REFRESH_SECRET || "refresh-secret-change-me",
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  },

  cors: {
    origin: process.env.CORS_ORIGIN || "http://localhost:3000",
  },

  backendURL: process.env.BACKEND_URL || "http://localhost:4444",

  bcrypt: {
    saltRounds: 12,
  },

  attendanceCronSecret: process.env.ATTENDANCE_CRON_SECRET || "attendance-cron-secret-change-me",

};

export default config;
