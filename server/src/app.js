import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import fs from "node:fs";
import config from "./config/index.js";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware.js";

// Route imports
import authRoutes from "./modules/auth/auth.routes.js";
import siteRoutes from "./modules/site/site.routes.js";
import userRoutes from "./modules/user/user.routes.js";
import leadRoutes from "./modules/lead/lead.routes.js";
import dealRoutes from "./modules/deal/deal.routes.js";
import clientRoutes from "./modules/client/client.routes.js";
import projectRoutes from "./modules/project/project.routes.js";
import dashboardRoutes from "./modules/dashboard/dashboard.routes.js";
import settingsRoutes from "./modules/settings/settings.routes.js";
import emailTemplateRoutes from "./modules/email-template/email-template.routes.js";
import serviceRoutes from "./modules/service/service.routes.js";
import packageRoutes from "./modules/package/package.routes.js";
import storageRoutes from "./modules/storage/storage.routes.js";
import teamRoutes from "./modules/team/team.routes.js";
import searchRoutes from "./modules/search/search.routes.js";
import notificationRoutes from "./modules/notification/notification.routes.js";
import systemPromptRoutes from "./modules/system-prompt/system-prompt.routes.js";
import aiRoutes from "./modules/ai/ai.routes.js";
import copilotRoutes from "./modules/copilot/copilot.routes.js";
import documentRoutes from "./modules/document/document.routes.js";
import meetingRoutes from "./modules/meeting/meeting.routes.js";
import followUpRoutes from "./modules/follow-up/follow-up.routes.js";
import sampleRoutes from "./modules/sample/sample.routes.js";
import planningStepRoutes from "./modules/planning-step/planning-step.routes.js";
import taskRoutes from "./modules/task/task.routes.js";
import milestoneRoutes from "./modules/milestone/milestone.routes.js";
import commentRoutes from "./modules/comment/comment.routes.js";
import attendanceRoutes from "./modules/attendance/attendance.routes.js";
import leaveRoutes from "./modules/leave/leave.routes.js";
import holidayRoutes from "./modules/holiday/holiday.routes.js";
import calendarRoutes from "./modules/calendar/calendar.routes.js";
import invoiceRoutes from "./modules/invoice/invoice.routes.js";
import announcementRoutes from "./modules/announcement/announcement.routes.js";
import jobRoutes from "./modules/job/job.routes.js";
import payrollRoutes from "./modules/payroll/payroll.routes.js";
import deliverableRoutes from "./modules/deliverable/deliverable.routes.js";
import expenseRoutes from "./modules/expense/expense.routes.js";
import campaignRoutes from "./modules/campaign/campaign.routes.js";
import reportRoutes from "./modules/report/report.routes.js";
import projectCycleRoutes from "./modules/project-cycle/project-cycle.routes.js";
import paymentAccountRoutes from "./modules/payment-account/payment-account.routes.js";

const app = express();

// ─── Global Middlewares ──────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use("/public", express.static("public"));
app.use(
  cors({
    origin: config.env === "development" ? true : config.cors.origin,
    credentials: true,
  })
);

// Skip body parsing for local file upload (streaming raw body to disk)
app.use((req, res, next) => {
  if (req.path === "/api/storage/upload/local") return next();
  express.json()(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === "/api/storage/upload/local") return next();
  express.urlencoded({ extended: true })(req, res, next);
});

if (config.env === "development") {
  app.use(morgan("dev"));
}

app.get("/", (_req, res) => {

  if (config.env === "development") {
    res.json({
      success: true,
      message: "TaskGo Agency API is running",
      environment: config.env,
      timestamp: new Date().toISOString(),
    });
  }
  else {
    res.redirect(config.cors.origin)
  }
});

// ─── Health Check ────────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({
    success: true,
    status: "HEALTHY",
    message: "TaskGo Agency API",
    timestamp: new Date().toISOString(),
  });
});

// ─── API Routes ──────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/site", siteRoutes);
app.use("/api/users", userRoutes);
app.use("/api/leads", leadRoutes);
app.use("/api/deals", dealRoutes);
app.use("/api/clients", clientRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/email-templates", emailTemplateRoutes);
app.use("/api/services", serviceRoutes);
app.use("/api/packages", packageRoutes);
app.use("/api/storage", storageRoutes);
app.use("/api/teams", teamRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/system-prompts", systemPromptRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/copilot", copilotRoutes);
app.use("/api/documents", documentRoutes);
app.use("/api/meetings", meetingRoutes);
app.use("/api/follow-ups", followUpRoutes);
app.use("/api/samples", sampleRoutes);
app.use("/api/planning-steps", planningStepRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/milestones", milestoneRoutes);
app.use("/api/comments", commentRoutes);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/leave", leaveRoutes);
app.use("/api/holidays", holidayRoutes);
app.use("/api/calendar", calendarRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/announcements", announcementRoutes);
app.use("/api/jobs", jobRoutes);
app.use("/api/payroll", payrollRoutes);
app.use("/api/deliverables", deliverableRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/project-cycles", projectCycleRoutes);
app.use("/api/payment-accounts", paymentAccountRoutes);

// ─── API Docs ────────────────────────────────────────────
// The OpenAPI spec, generated from the route table by
// `npm run docs:openapi`. Read per request so a regenerated file is served
// without a restart.
const OPENAPI_FILE = new URL("../docs/openapi.json", import.meta.url);

// Under /api like every other endpoint — in production only /api/* is routed
// to this server; any other path is answered by the web app.
app.get("/api/docs-json", async (_req, res) => {
  try {
    res.type("application/json").send(await fs.promises.readFile(OPENAPI_FILE, "utf8"));
  } catch {
    res.status(404).json({
      success: false,
      message: "API spec not found.",
    });
  }
});

// ─── Error Handling ──────────────────────────────────────
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
