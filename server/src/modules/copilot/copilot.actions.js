import { randomUUID } from "node:crypto";
import { z } from "zod";

import prisma from "../../utils/prisma.js";
import { ApiError } from "../../utils/apiError.js";
import { sendMail } from "../../utils/mailer.js";

import taskService from "../task/task.service.js";
import followUpService from "../follow-up/follow-up.service.js";
import expenseService from "../expense/expense.service.js";
import invoiceService from "../invoice/invoice.service.js";
import leadService from "../lead/lead.service.js";
import dealService from "../deal/deal.service.js";
import reportService from "../report/report.service.js";
import emailTemplateService from "../email-template/email-template.service.js";

/**
 * Copilot actions — the write half of the assistant, kept behind a human.
 *
 * The model never writes. When it wants to change something it calls a
 * propose_* tool, which validates the payload, resolves every id it references
 * to a real record, and returns a card. Nothing is saved. The card is stored on
 * the assistant message and rendered in the chat with a button; only pressing
 * that button reaches execute(), and execute() calls the same service the REST
 * route calls, so every rule, permission check and notification behaves exactly
 * as it does when a person fills in the form by hand.
 *
 * Two properties this file exists to guarantee:
 *   1. A proposal is inert. Nothing here writes during a propose_* call.
 *   2. A proposal cannot reference a record that does not exist — describe()
 *      loads each one, so a hallucinated id fails at proposal time with an
 *      error the model can act on, not at execution time in the user's face.
 */

/** How long an unexecuted proposal stays actionable. */
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

const TASK_STATUSES = ["NEW", "ACKNOWLEDGED", "IN_PROGRESS", "IN_REVIEW", "CLIENT_REVIEW", "COMPLETED"];
const TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];
const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "UNQUALIFIED", "CONVERTED", "LOST"];
const FOLLOW_UP_TYPES = ["CALL", "EMAIL", "MEETING", "TASK", "OTHER"];
const PAYMENT_MODES = ["CASH", "BANK_TRANSFER", "UPI", "CARD", "COMPANY_CARD", "OTHER"];

const isoDate = z
  .string()
  .min(4)
  .refine((v) => !Number.isNaN(Date.parse(v)), "Use an ISO date, e.g. 2026-09-30");

const fullName = (u) => (u ? `${u.firstName} ${u.lastName}`.trim() : null);

/** A date for a card, in the reader's terms rather than an ISO string. */
const showDate = (v) =>
  v
    ? new Date(v).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : "—";

const showMoney = (n, currency = "INR") =>
  `${currency} ${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Drop keys the model left null so they never overwrite a service default. */
function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));
}

// ─── Action definitions ──────────────────────────────────
//
// Each entry: the tool the model sees, the payload contract, a describe() that
// turns a payload into a reviewable card, and an execute() that performs it.

const create_task = {
  label: "Create task",
  button: "Create task",
  /** Outward-facing actions warn harder in the UI; this one is internal. */
  danger: false,

  tool: {
    name: "propose_create_task",
    description:
      "Propose creating a task on a project. This does NOT create it — it shows the user a card with a Create button, and only they can confirm. Find the project and assignee ids with query_database first; made-up ids are rejected. After calling this, tell the user the task is ready for them to confirm — never say it was created.",
    parameters: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project the task belongs to." },
        title: { type: "string", description: "Task title, max 200 characters." },
        description: { type: "string", description: "Optional detail of the work." },
        priority: { type: "string", enum: TASK_PRIORITIES, description: "Defaults to MEDIUM." },
        dueDate: { type: "string", description: "Optional ISO date, e.g. 2026-09-30." },
        assigneeId: { type: "string", description: "Optional User id to assign it to." },
        milestoneId: { type: "string", description: "Optional milestone on the same project." },
        planningStepId: { type: "string", description: "Optional planning step on the same project." },
      },
      required: ["projectId", "title"],
    },
  },

  schema: z.object({
    projectId: z.string().min(1),
    title: z.string().min(1).max(200),
    description: z.string().max(5000).nullish(),
    priority: z.enum(TASK_PRIORITIES).nullish(),
    dueDate: isoDate.nullish(),
    assigneeId: z.string().min(1).nullish(),
    milestoneId: z.string().min(1).nullish(),
    planningStepId: z.string().min(1).nullish(),
  }),

  async describe(p) {
    const project = await prisma.project.findUnique({
      where: { id: p.projectId },
      select: { id: true, name: true, client: { select: { companyName: true } } },
    });
    if (!project) throw ApiError.badRequest(`No project with id ${p.projectId}.`);

    const warnings = [];
    let assignee = null;
    if (p.assigneeId) {
      assignee = await prisma.user.findUnique({
        where: { id: p.assigneeId },
        select: { firstName: true, lastName: true, status: true },
      });
      if (!assignee) throw ApiError.badRequest(`No user with id ${p.assigneeId}.`);
      if (assignee.status !== "ACTIVE") {
        warnings.push(`That assignee's account is ${String(assignee.status).toLowerCase()}.`);
      }
    }

    if (p.milestoneId) {
      const m = await prisma.milestone.findUnique({
        where: { id: p.milestoneId },
        select: { projectId: true },
      });
      if (!m) throw ApiError.badRequest(`No milestone with id ${p.milestoneId}.`);
      if (m.projectId !== p.projectId) {
        throw ApiError.badRequest("That milestone belongs to a different project.");
      }
    }

    if (p.planningStepId) {
      const s = await prisma.planningStep.findUnique({
        where: { id: p.planningStepId },
        select: { projectId: true },
      });
      if (!s) throw ApiError.badRequest(`No planning step with id ${p.planningStepId}.`);
      if (s.projectId !== p.projectId) {
        throw ApiError.badRequest("That planning step belongs to a different project.");
      }
    }

    return {
      title: p.title,
      fields: [
        { label: "Project", value: project.name },
        { label: "Client", value: project.client?.companyName || "—" },
        { label: "Assignee", value: fullName(assignee) || "Unassigned" },
        { label: "Priority", value: p.priority || "MEDIUM" },
        { label: "Due", value: showDate(p.dueDate) },
        ...(p.description ? [{ label: "Description", value: p.description, wide: true }] : []),
      ],
      warnings,
    };
  },

  async execute(p, user) {
    const task = await taskService.createTask(compact(p), user.id);
    return {
      message: `Task "${task.title}" created.`,
      entity: { type: "task", id: task.id, name: task.title },
    };
  },
};

const create_follow_up = {
  label: "Create follow-up",
  button: "Create follow-up",
  danger: false,

  tool: {
    name: "propose_create_follow_up",
    description:
      "Propose a follow-up on a lead or a deal. This does NOT create it — the user gets a card with a Create button and must confirm. Give exactly one of leadId or dealId. After calling this, say the follow-up is ready to confirm; never say it was created.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the follow-up is, max 200 characters." },
        dueAt: { type: "string", description: "ISO date or date-time it is due." },
        type: { type: "string", enum: FOLLOW_UP_TYPES, description: "Defaults to CALL." },
        notes: { type: "string", description: "Optional notes." },
        leadId: { type: "string", description: "Lead it belongs to. Omit if dealId is given." },
        dealId: { type: "string", description: "Deal it belongs to. Omit if leadId is given." },
      },
      required: ["title", "dueAt"],
    },
  },

  schema: z
    .object({
      title: z.string().min(1).max(200),
      dueAt: isoDate,
      type: z.enum(FOLLOW_UP_TYPES).nullish(),
      notes: z.string().max(5000).nullish(),
      leadId: z.string().min(1).nullish(),
      dealId: z.string().min(1).nullish(),
    })
    .refine((v) => !!v.leadId !== !!v.dealId, {
      message: "Give exactly one of leadId or dealId.",
    }),

  async describe(p) {
    let onLabel = null;
    let onWhat = null;

    if (p.leadId) {
      const lead = await prisma.lead.findUnique({
        where: { id: p.leadId },
        select: { contactName: true, companyName: true, status: true },
      });
      if (!lead) throw ApiError.badRequest(`No lead with id ${p.leadId}.`);
      onLabel = "Lead";
      onWhat = [lead.contactName, lead.companyName].filter(Boolean).join(" · ");
    } else {
      const deal = await prisma.deal.findUnique({
        where: { id: p.dealId },
        select: { title: true, stage: true },
      });
      if (!deal) throw ApiError.badRequest(`No deal with id ${p.dealId}.`);
      onLabel = "Deal";
      onWhat = `${deal.title} · ${deal.stage}`;
    }

    return {
      title: p.title,
      fields: [
        { label: onLabel, value: onWhat },
        { label: "Type", value: p.type || "CALL" },
        { label: "Due", value: showDate(p.dueAt) },
        ...(p.notes ? [{ label: "Notes", value: p.notes, wide: true }] : []),
      ],
      warnings: [],
    };
  },

  async execute(p, user) {
    const followUp = await followUpService.createFollowUp(compact(p), user.id);
    return { message: `Follow-up "${followUp.title}" created.` };
  },
};

const update_status = {
  label: "Change status",
  button: "Apply change",
  danger: false,

  tool: {
    name: "propose_update_status",
    description:
      "Propose moving a task, lead or deal to a different status. This does NOT apply it — the user gets a card with a confirm button. Valid values differ per entity: task = NEW|ACKNOWLEDGED|IN_PROGRESS|IN_REVIEW|CLIENT_REVIEW|COMPLETED; lead and deal statuses come from describe_schema. After calling this, say the change is ready to confirm; never say it was applied.",
    parameters: {
      type: "object",
      properties: {
        entity: { type: "string", enum: ["task", "lead", "deal"], description: "What is moving." },
        id: { type: "string", description: "Id of the task, lead or deal." },
        status: { type: "string", description: "Target status (for a deal, the target stage)." },
        reason: {
          type: "string",
          description: "Why. Recorded as task feedback, or as the lost reason on a lead/deal.",
        },
      },
      required: ["entity", "id", "status"],
    },
  },

  schema: z.object({
    entity: z.enum(["task", "lead", "deal"]),
    id: z.string().min(1),
    status: z.string().min(1).max(60),
    reason: z.string().max(5000).nullish(),
  }),

  async describe(p) {
    let name = null;
    let current = null;

    if (p.entity === "task") {
      const t = await prisma.task.findUnique({
        where: { id: p.id },
        select: { title: true, status: true, project: { select: { name: true } } },
      });
      if (!t) throw ApiError.badRequest(`No task with id ${p.id}.`);
      if (!TASK_STATUSES.includes(p.status)) {
        throw ApiError.badRequest(`"${p.status}" is not a task status. Use one of: ${TASK_STATUSES.join(", ")}.`);
      }
      name = `${t.title} (${t.project?.name || "—"})`;
      current = t.status;
    } else if (p.entity === "lead") {
      const l = await prisma.lead.findUnique({
        where: { id: p.id },
        select: { contactName: true, companyName: true, status: true },
      });
      if (!l) throw ApiError.badRequest(`No lead with id ${p.id}.`);
      if (!LEAD_STATUSES.includes(p.status)) {
        throw ApiError.badRequest(`"${p.status}" is not a lead status. Use one of: ${LEAD_STATUSES.join(", ")}.`);
      }
      name = [l.contactName, l.companyName].filter(Boolean).join(" · ");
      current = l.status;
    } else {
      const d = await prisma.deal.findUnique({
        where: { id: p.id },
        select: { title: true, stage: true },
      });
      if (!d) throw ApiError.badRequest(`No deal with id ${p.id}.`);
      name = d.title;
      current = d.stage;
    }

    if (current === p.status) {
      throw ApiError.badRequest(`That ${p.entity} is already ${p.status}.`);
    }

    return {
      title: name,
      fields: [
        { label: "Type", value: p.entity },
        { label: "From", value: current },
        { label: "To", value: p.status },
        ...(p.reason ? [{ label: "Reason", value: p.reason, wide: true }] : []),
      ],
      warnings: [],
    };
  },

  async execute(p, user) {
    if (p.entity === "task") {
      const task = await taskService.updateTask(
        p.id,
        compact({ status: p.status, feedback: p.reason }),
        user.id
      );
      return {
        message: `Task moved to ${p.status}.`,
        entity: { type: "task", id: task.id, name: task.title },
      };
    }

    if (p.entity === "lead") {
      const lead = await leadService.updateLeadStatus(p.id, p.status, p.reason || undefined);
      return {
        message: `Lead moved to ${p.status}.`,
        entity: { type: "lead", id: lead.id, name: lead.contactName || lead.companyName },
      };
    }

    await dealService.updateDealStage(p.id, p.status, { lostReason: p.reason || undefined });
    return { message: `Deal moved to ${p.status}.` };
  },
};

const log_expense = {
  label: "Record expense",
  button: "Record expense",
  danger: false,

  tool: {
    name: "propose_log_expense",
    description:
      "Propose recording an expense. This does NOT record it — the user confirms on a card. categoryId must be a real ExpenseCategory; look it up with query_database first. After calling this, say the expense is ready to confirm; never say it was recorded.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "What the spend was for." },
        categoryId: { type: "string", description: "ExpenseCategory id." },
        amount: { type: "number", description: "Amount before tax." },
        expenseDate: { type: "string", description: "ISO date the money was spent." },
        taxAmount: { type: "number", description: "Optional tax on top." },
        description: { type: "string", description: "Optional detail." },
        projectId: { type: "string", description: "Optional project to attribute it to." },
        clientId: { type: "string", description: "Optional client to attribute it to." },
        isBillable: { type: "boolean", description: "Whether it is re-billable to the client." },
        paymentMode: { type: "string", enum: PAYMENT_MODES },
      },
      required: ["title", "categoryId", "amount", "expenseDate"],
    },
  },

  schema: z.object({
    title: z.string().min(1).max(200),
    categoryId: z.string().min(1),
    amount: z.number().min(0),
    expenseDate: isoDate,
    taxAmount: z.number().min(0).nullish(),
    description: z.string().max(5000).nullish(),
    projectId: z.string().min(1).nullish(),
    clientId: z.string().min(1).nullish(),
    isBillable: z.boolean().nullish(),
    paymentMode: z.enum(PAYMENT_MODES).nullish(),
  }),

  async describe(p) {
    const category = await prisma.expenseCategory.findUnique({
      where: { id: p.categoryId },
      select: { name: true, isActive: true, requiresReceipt: true },
    });
    if (!category) throw ApiError.badRequest(`No expense category with id ${p.categoryId}.`);
    if (!category.isActive) throw ApiError.badRequest(`The "${category.name}" category is inactive.`);

    const warnings = [];
    // The copilot has no file to attach, so a receipt-bound category would fail
    // validation on submit. Recording it as a draft is the honest way through.
    if (category.requiresReceipt) {
      warnings.push(`"${category.name}" normally needs a receipt — this will be saved as a draft for you to attach one.`);
    }

    let project = null;
    if (p.projectId) {
      project = await prisma.project.findUnique({
        where: { id: p.projectId },
        select: { name: true },
      });
      if (!project) throw ApiError.badRequest(`No project with id ${p.projectId}.`);
    }

    let client = null;
    if (p.clientId) {
      client = await prisma.client.findUnique({
        where: { id: p.clientId },
        select: { companyName: true },
      });
      if (!client) throw ApiError.badRequest(`No client with id ${p.clientId}.`);
    }

    const total = Number(p.amount) + Number(p.taxAmount || 0);

    return {
      title: p.title,
      fields: [
        { label: "Category", value: category.name },
        { label: "Amount", value: showMoney(p.amount) },
        ...(p.taxAmount ? [{ label: "Tax", value: showMoney(p.taxAmount) }] : []),
        { label: "Total", value: showMoney(total) },
        { label: "Date", value: showDate(p.expenseDate) },
        ...(project ? [{ label: "Project", value: project.name }] : []),
        ...(client ? [{ label: "Client", value: client.companyName }] : []),
        { label: "Billable", value: p.isBillable ? "Yes" : "No" },
        ...(p.description ? [{ label: "Notes", value: p.description, wide: true }] : []),
      ],
      warnings,
    };
  },

  async execute(p, user) {
    const category = await prisma.expenseCategory.findUnique({
      where: { id: p.categoryId },
      select: { requiresReceipt: true },
    });

    const expense = await expenseService.create(
      compact({ ...p, status: category?.requiresReceipt ? "DRAFT" : undefined }),
      user
    );
    return { message: `Expense ${expense.reference} recorded (${expense.status}).` };
  },
};

const send_email = {
  label: "Send email",
  button: "Send email",
  danger: true,

  tool: {
    name: "propose_send_email",
    description:
      "Propose sending an email. This does NOT send it — the user reads the draft on a card and presses Send. Use it for outreach and nudges; to send an invoice use propose_send_invoice instead, which attaches the PDF. After calling this, say the draft is ready for them to review; never say it was sent.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        subject: { type: "string", description: "Subject line." },
        body: {
          type: "string",
          description: "Message body as plain text. Use blank lines between paragraphs; it is wrapped in the agency's branded template.",
        },
        cc: { type: "string", description: "Optional CC address." },
        bcc: { type: "string", description: "Optional BCC address." },
      },
      required: ["to", "subject", "body"],
    },
  },

  schema: z.object({
    to: z.string().email("That is not a valid email address."),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(20000),
    cc: z.string().email().nullish(),
    bcc: z.string().email().nullish(),
  }),

  async describe(p) {
    const warnings = [];
    // Worth surfacing: an address nobody in the CRM owns is the shape a
    // hallucinated recipient takes.
    const [user, client, lead] = await Promise.all([
      prisma.user.findFirst({ where: { email: p.to }, select: { firstName: true, lastName: true } }),
      prisma.client.findFirst({ where: { email: p.to }, select: { companyName: true } }),
      prisma.lead.findFirst({ where: { email: p.to }, select: { contactName: true, companyName: true } }),
    ]);
    const known =
      fullName(user) || client?.companyName || lead?.contactName || lead?.companyName || null;
    if (!known) warnings.push("This address does not match any client, lead or user in the CRM.");

    return {
      title: p.subject,
      fields: [
        { label: "To", value: known ? `${p.to} (${known})` : p.to },
        ...(p.cc ? [{ label: "CC", value: p.cc }] : []),
        ...(p.bcc ? [{ label: "BCC", value: p.bcc }] : []),
        { label: "Message", value: p.body, wide: true },
      ],
      warnings,
    };
  },

  async execute(p, user) {
    const [site, settings, template] = await Promise.all([
      prisma.site.findUnique({ where: { id: "default" }, select: { name: true } }),
      prisma.settings.findUnique({ where: { id: "default" }, select: { smtpEmail: true } }),
      emailTemplateService.getTemplateBySlug("copilot-email"),
    ]);

    const rendered = emailTemplateService.renderTemplate(template, {
      siteName: site?.name || "TaskGo Agency",
      subject: p.subject,
      senderName: fullName(user) || site?.name || "",
      senderEmail: user?.email || "",
      // Plain text in, HTML out: paragraph breaks survive, tags do not.
      bodyHtml: p.body
        .split(/\n{2,}/)
        .map(
          (para) =>
            `<p style="margin:0 0 16px;color:#334155;font-size:14px;line-height:1.7;">${escapeHtml(para).replace(/\n/g, "<br>")}</p>`
        )
        .join(""),
    });

    await sendMail({
      to: p.to,
      cc: p.cc || undefined,
      // Same convention as invoices: the agency keeps a copy of what went out.
      bcc: p.bcc || settings?.smtpEmail || undefined,
      subject: p.subject,
      html: rendered.body,
    });

    return { message: `Email sent to ${p.to}.` };
  },
};

const send_invoice = {
  label: "Send invoice",
  button: "Send invoice",
  danger: true,

  tool: {
    name: "propose_send_invoice",
    description:
      "Propose emailing an invoice to its client, with the PDF attached. This does NOT send it — the user confirms on a card showing the recipient. After calling this, say it is ready for them to send; never say it was sent.",
    parameters: {
      type: "object",
      properties: {
        invoiceId: { type: "string", description: "Invoice id." },
        to: { type: "string", description: "Optional override recipient. Defaults to the invoice's Bill To email." },
        cc: { type: "string", description: "Optional CC address." },
        bcc: { type: "string", description: "Optional BCC. Defaults to the agency's own SMTP mailbox." },
        message: { type: "string", description: "Optional short covering note." },
      },
      required: ["invoiceId"],
    },
  },

  schema: z.object({
    invoiceId: z.string().min(1),
    to: z.string().email().nullish(),
    cc: z.string().email().nullish(),
    bcc: z.string().email().nullish(),
    message: z.string().max(5000).nullish(),
  }),

  async describe(p) {
    const invoice = await prisma.invoice.findUnique({
      where: { id: p.invoiceId },
      select: {
        invoiceNumber: true, status: true, total: true, amountPaid: true, currency: true,
        dueDate: true, billToName: true, billToEmail: true, isActive: true,
        client: { select: { companyName: true, email: true } },
      },
    });
    if (!invoice) throw ApiError.badRequest(`No invoice with id ${p.invoiceId}.`);
    if (!invoice.isActive) {
      throw ApiError.badRequest("That invoice is inactive and cannot be sent. Reactivate it first.");
    }
    if (invoice.status === "CANCELLED") {
      throw ApiError.badRequest("That invoice is cancelled and cannot be sent.");
    }

    const recipient = p.to || invoice.billToEmail || invoice.client?.email;
    if (!recipient) {
      throw ApiError.badRequest(
        "That invoice has no client email. Add one on its Bill To details, or pass `to`."
      );
    }

    const warnings = [];
    if (invoice.status !== "DRAFT") {
      warnings.push(`This invoice is already ${invoice.status} — sending it again will re-deliver it.`);
    }

    const cur = invoice.currency || "INR";
    const due = Number(invoice.total) - Number(invoice.amountPaid);

    return {
      title: `Invoice ${invoice.invoiceNumber}`,
      fields: [
        { label: "To", value: recipient },
        ...(p.cc ? [{ label: "CC", value: p.cc }] : []),
        { label: "Client", value: invoice.billToName || invoice.client?.companyName || "—" },
        { label: "Total", value: showMoney(invoice.total, cur) },
        { label: "Due", value: `${showMoney(due, cur)} by ${showDate(invoice.dueDate)}` },
        { label: "Status", value: invoice.status },
        ...(p.message ? [{ label: "Note", value: p.message, wide: true }] : []),
      ],
      warnings,
    };
  },

  async execute(p, user) {
    const res = await invoiceService.sendToClient(
      p.invoiceId,
      compact({ to: p.to, cc: p.cc, bcc: p.bcc, message: p.message }),
      user
    );
    return { message: `Invoice emailed to ${res.to}.` };
  },
};

export const ACTIONS = {
  create_task,
  create_follow_up,
  update_status,
  log_expense,
  send_email,
  send_invoice,
};

/**
 * The action tools and run_report, described for display rather than for
 * calling — the "what can this AI do" panel and nothing else.
 */
export function actionToolCatalog() {
  const proposals = Object.values(ACTIONS).map((def) => ({
    name: def.tool.name,
    label: def.label,
    description: def.tool.description,
    kind: "write",
    danger: !!def.danger,
  }));

  return [
    ...proposals,
    {
      name: runReportTool.name,
      label: "Run project report",
      description: runReportTool.description,
      kind: "read",
      danger: false,
    },
  ];
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Turn a ZodError into one line the model can actually act on. */
function zodMessage(err) {
  return err.issues
    .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
    .join("; ");
}

// ─── Read-only tools ─────────────────────────────────────

/**
 * A month's report for one project, pre-assembled.
 *
 * Without this the model rebuilds a report out of six or seven query_database
 * calls and usually gets the cost side wrong. The snapshot is trimmed on the
 * way out — the full one carries every invoice line, payment and daily ad stat,
 * which is far more than an answer needs and enough to exhaust the context.
 */
const runReportTool = {
  name: "run_report",
  description:
    "Get one project's monthly report: money billed, received, outstanding, costs and profit; ad spend and leads; content performance; delivery progress. Read-only, and much better than assembling these numbers yourself with query_database. Find the projectId first.",
  parameters: {
    type: "object",
    properties: {
      projectId: { type: "string", description: "Project to report on." },
      year: { type: "number", description: "Four-digit year, e.g. 2026." },
      month: { type: "number", description: "Month number, 1-12." },
    },
    required: ["projectId", "year", "month"],
  },
  handler: async (args) => {
    const year = Number(args?.year);
    const month = Number(args?.month);
    if (!args?.projectId) return { error: "run_report needs a projectId." };
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return { error: "run_report needs a four-digit year." };
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return { error: "run_report needs a month between 1 and 12." };
    }

    const s = await reportService.buildSnapshot(args.projectId, year, month);

    return {
      period: `${month}/${year}`,
      project: { id: s.project.id, name: s.project.name, status: s.project.status },
      client: s.project.client?.companyName || null,
      finance: {
        billed: s.finance.billed,
        received: s.finance.received,
        outstanding: s.finance.outstanding,
        cost: s.finance.cost,
        profit: s.finance.profit,
        invoiceCount: s.finance.invoices.length,
        unpaidInvoices: s.finance.invoices.filter((i) => i.due > 0).map((i) => ({
          invoiceNumber: i.invoiceNumber,
          due: i.due,
          status: i.status,
        })),
        topTaskCosts: s.finance.topTaskCosts,
      },
      ads: { spend: s.ads.spend, leads: s.ads.leads, campaigns: s.ads.rows.length },
      content: {
        pieces: s.dashboard.totalContentPieces,
        reach: s.dashboard.totalReach,
        engagement: s.dashboard.totalEngagement,
        avgEngagementRate: s.dashboard.avgEngagementRate,
        costPerLead: s.dashboard.costPerLead,
      },
      delivery: {
        tasks: s.delivery.tasks,
        steps: s.delivery.steps,
        milestones: s.delivery.milestones.length,
        deliverables: s.delivery.deliverables.length,
      },
      note: "Growth metrics, audit scores and issues are entered by hand on the report page and are not included here.",
    };
  },
};

// ─── Tool assembly ───────────────────────────────────────

/**
 * Build the tool list for one copilot message.
 *
 * `collect` receives each accepted proposal. Everything is per request — the
 * proposals array belongs to a single message, so concurrent chats cannot see
 * each other's cards.
 */
export function copilotTools(collect) {
  const proposals = Object.entries(ACTIONS).map(([kind, def]) => ({
    name: def.tool.name,
    description: def.tool.description,
    parameters: def.tool.parameters,
    handler: async (args) => {
      const parsed = def.schema.safeParse(args || {});
      if (!parsed.success) {
        return { error: `Invalid ${kind} proposal — ${zodMessage(parsed.error)}` };
      }

      let card;
      try {
        card = await def.describe(parsed.data);
      } catch (err) {
        // A bad id is the model's problem to fix, so it comes back as a tool
        // result rather than blowing up the whole turn.
        return { error: err?.message || `Could not prepare that ${kind}.` };
      }

      const proposal = {
        id: randomUUID(),
        kind,
        label: def.label,
        button: def.button,
        danger: def.danger,
        title: card.title,
        fields: card.fields,
        warnings: card.warnings || [],
        payload: parsed.data,
        status: "pending",
        proposedAt: new Date().toISOString(),
      };
      collect(proposal);

      return {
        proposed: true,
        actionId: proposal.id,
        kind,
        summary: card.title,
        warnings: proposal.warnings,
        note: "NOTHING HAS BEEN SAVED. The user now sees a card with a confirm button and may or may not press it. Tell them it is ready for them to confirm. Do not say it is done, created or sent.",
      };
    },
  }));

  return [...proposals, runReportTool];
}

// ─── Execution ───────────────────────────────────────────

/**
 * Run a proposal the user confirmed.
 *
 * Re-validates the payload rather than trusting the stored copy: the row has
 * been sitting in the database since the model wrote it, and the services below
 * are the real write path.
 */
export async function runAction(proposal, user) {
  const def = ACTIONS[proposal?.kind];
  if (!def) throw ApiError.badRequest("That action type is no longer supported.");

  if (proposal.status === "done") throw ApiError.badRequest("That action has already been run.");

  const age = Date.now() - Date.parse(proposal.proposedAt || 0);
  if (Number.isFinite(age) && age > PROPOSAL_TTL_MS) {
    throw ApiError.badRequest(
      "This suggestion is over a day old — the data behind it has probably moved on. Ask again for a fresh one."
    );
  }

  const parsed = def.schema.safeParse(proposal.payload || {});
  if (!parsed.success) throw ApiError.badRequest(`This action is no longer valid — ${zodMessage(parsed.error)}`);

  return def.execute(parsed.data, user);
}
