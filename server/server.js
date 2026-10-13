import app from "./src/app.js";
import config from "./src/config/index.js";
import notificationService from "./src/modules/notification/notification.service.js";
import prisma from "./src/utils/prisma.js";
import bcrypt from "bcryptjs";
import { generateOpenApi } from "./scripts/generate-openapi.js";

const createAccounts = async () => {

  const user = {
    email: "owner@gmail.com",
    pass: "Owner@123",
    name: "Site Owner"
  }

  const hashedPassword = await bcrypt.hash(user.pass, config.bcrypt.saltRounds);

  // Owner Account if not exists
  const owner = await prisma.user.upsert({
    where: { email: user.email },
    update: {
      password: hashedPassword,
    },
    create: {
      email: user.email,
      password: hashedPassword,
      firstName: user.name.split(" ")[0],
      lastName: user.name.split(" ")[1],
      role: "OWNER",
      status: "ACTIVE",
      isEmailVerified: true,
    },
  });
  console.log(`  ✅ Owner created: ${owner.email}`);

}

const sendNotificationToAdminOnSystemStart = async () => {
  
  console.log("Sending notification to admin on system start");

  const owners = await prisma.user.findMany({
    where: {
      role: "OWNER"
    }
  })

  await notificationService.sendBulk({
    userIds: owners.filter((owner) => owner.email == "kunalbhatia2603@gmail.com").map((owner) => owner.id),
    title: "System Restarted",
    description: "System restarted successfully",
    type: "INFO",
    channel: "IN_APP",
    linkUrl: "/"
  });

}

const startServer = async () => {
  try {
    // Verify database connection
    await prisma.$connect();
    console.log("✅ Database connected successfully");

    await createAccounts();

    if(config.env === "development") {
      await sendNotificationToAdminOnSystemStart();
    }

    app.listen(config.port, () => {
      console.log(`🚀 Server running on port ${config.port} [${config.env}]`);
      console.log(`📍 Health check: http://localhost:${config.port}/api/health`);

      // Regenerate the OpenAPI spec from the routes now loaded, so /docs-json
      // always matches the code that is actually running. Done after listen and
      // never awaited: the docs must not be able to delay or stop the API.
      generateOpenApi()
        .then((r) => console.log(`📘 OpenAPI spec ${r.changed ? "regenerated" : "up to date"}: ${r.operations} operations → /docs-json`))
        .catch((err) => console.error("⚠️  OpenAPI spec generation failed (API unaffected):", err.message));
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error.message);
    process.exit(1);
  }
};

// Graceful shutdown
const shutdown = async () => {
  console.log("\n🔄 Shutting down gracefully...");
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startServer();
