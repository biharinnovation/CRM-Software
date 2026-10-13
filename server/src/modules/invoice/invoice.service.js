import prisma from "../../utils/prisma.js";
import { snapshotOf } from "../payment-account/payment-account.service.js";
import { ApiError } from "../../utils/apiError.js";
import notificationService from "../notification/notification.service.js";
import emailTemplateService from "../email-template/email-template.service.js";
import { sendMail } from "../../utils/mailer.js";
import { renderInvoicePdf } from "./invoice.pdf.js";

const INVOICE_INCLUDE = {
  items: { orderBy: { position: "asc" } },
  paymentAccount: { select: { id: true, label: true, type: true, isActive: true } },
  payments: {
    orderBy: { paidAt: "desc" },
    include: { recordedBy: { select: { id: true, firstName: true, lastName: true } } },
  },
  project: {
    select: { id: true, name: true, status: true },
  },
  client: {
    select: { id: true, companyName: true, contactName: true, email: true },
  },
  createdBy: {
    select: { id: true, firstName: true, lastName: true, email: true },
  },
};

/**
 * Resolve the payment account for an invoice and snapshot its details.
 *
 * Falls back to the default account when none is named, so an invoice never
 * goes out with no way to pay it if a default exists.
 *
 * @returns {Promise<{paymentAccountId: string|null, paymentDetails: object|null, account: object|null}>}
 */
async function resolvePaymentAccount(paymentAccountId) {
  const account = paymentAccountId
    ? await prisma.paymentAccount.findUnique({ where: { id: paymentAccountId } })
    : await prisma.paymentAccount.findFirst({ where: { isDefault: true, isActive: true } });

  if (paymentAccountId && !account) {
    throw ApiError.badRequest("Payment account not found");
  }
  if (paymentAccountId && !account.isActive) {
    throw ApiError.badRequest("That payment account is no longer active");
  }

  return {
    paymentAccountId: account?.id || null,
    paymentDetails: snapshotOf(account),
    account: account || null,
  };
}

/** Invoice series used when no payment account is attached. */
const DEFAULT_INVOICE_PREFIX = "INV";

/** Details a given method actually needs, so a record is never half-useful. */
const REQUIRED_BY_METHOD = {
  UPI: [["referenceNo", "UTR / transaction reference"]],
  BANK_TRANSFER: [["referenceNo", "UTR / transaction reference"]],
  CHEQUE: [
    ["referenceNo", "Cheque number"],
    ["chequeBank", "Bank"],
    ["chequeDate", "Cheque date"],
  ],
  CARD: [],
  CASH: [],
  OTHER: [],
};

/**
 * Round to 2 decimals (money).
 */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Only these roles may see an invoice that has been deactivated. */
const INACTIVE_VIEWERS = ["OWNER", "ADMIN"];
const canSeeInactive = (user) => INACTIVE_VIEWERS.includes(user?.role);

/**
 * An inactive invoice is frozen: no edits, payments or sends until it is
 * reactivated. Checked on every write path, not just in the UI.
 */
function assertActive(invoice) {
  if (invoice && invoice.isActive === false) {
    throw ApiError.badRequest("This invoice is inactive. Reactivate it before making changes.");
  }
}

/**
 * Compute money totals from raw line items + discount + GST split + any
 * balance carried forward from a previous invoice.
 *
 * GST is three independent rates (CGST/SGST/IGST), each applied to the same
 * taxable base — never compounded on each other. previousDueAmount is added
 * on top of the taxed amount untaxed, matching how a carried-forward balance
 * is not itself subject to tax again.
 */
function computeTotals(items, discountAmount = 0, gst = {}, previousDueAmount = 0) {
  const lineItems = items.map((it, idx) => {
    const quantity = round2(it.quantity ?? 1);
    const unitPrice = round2(it.unitPrice ?? 0);
    const amount = round2(quantity * unitPrice);
    return {
      name: it.name,
      description: it.description || null,
      quantity,
      unitPrice,
      amount,
      position: idx,
    };
  });

  const subtotal = round2(lineItems.reduce((sum, it) => sum + it.amount, 0));
  const discount = round2(discountAmount);
  const taxableBase = Math.max(0, subtotal - discount);

  const cgstPct = round2(gst.cgstPercent || 0);
  const sgstPct = round2(gst.sgstPercent || 0);
  const igstPct = round2(gst.igstPercent || 0);
  const cgstAmount = round2((taxableBase * cgstPct) / 100);
  const sgstAmount = round2((taxableBase * sgstPct) / 100);
  const igstAmount = round2((taxableBase * igstPct) / 100);
  const taxPct = round2(cgstPct + sgstPct + igstPct);
  const taxAmount = round2(cgstAmount + sgstAmount + igstAmount);

  // The taxed invoice amount, before any carried-forward balance is added.
  const invoiceAmount = round2(taxableBase + taxAmount);
  const prevDue = round2(previousDueAmount || 0);
  const total = round2(invoiceAmount + prevDue);

  return {
    lineItems, subtotal, discount,
    cgstPct, sgstPct, igstPct, cgstAmount, sgstAmount, igstAmount,
    taxPct, taxAmount, invoiceAmount, prevDue, total,
  };
}


/** Escape user-entered text before it goes into an HTML email. */
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Money for the email body. Invoices store their own currency, so use it. */
function money(amount, currency = "INR") {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(Number(amount) || 0);
}

const emailDate = (d) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";

/**
 * The line items as an HTML table.
 *
 * The template renderer only substitutes {{variables}} — it cannot loop — so
 * anything repeating has to arrive already rendered.
 */
function itemsTable(invoice) {
  const cur = invoice.currency || "INR";

  const rows = (invoice.items || [])
    .map(
      (it) => `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#334155;font-size:13px;">
            <strong>${esc(it.name)}</strong>
            ${it.description ? `<br><span style="color:#94a3b8;font-size:12px;">${esc(it.description)}</span>` : ""}
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:13px;text-align:right;white-space:nowrap;">${Number(it.quantity)}</td>
          <td style="padding:10px 0 10px 12px;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:13px;text-align:right;white-space:nowrap;">${money(it.unitPrice, cur)}</td>
          <td style="padding:10px 0 10px 12px;border-bottom:1px solid #f1f5f9;color:#0f172a;font-size:13px;text-align:right;white-space:nowrap;">${money(it.amount, cur)}</td>
        </tr>`
    )
    .join("");

  const totalRow = (label, value, bold = false) => `
        <tr>
          <td colspan="3" style="padding:6px 0;color:${bold ? "#0f172a" : "#64748b"};font-size:13px;text-align:right;font-weight:${bold ? 700 : 400};">${label}</td>
          <td style="padding:6px 0 6px 12px;color:${bold ? "#0f172a" : "#334155"};font-size:13px;text-align:right;font-weight:${bold ? 700 : 400};white-space:nowrap;">${value}</td>
        </tr>`;

  const discount = Number(invoice.discountAmount) || 0;
  const cgstPct = Number(invoice.cgstPercent) || 0;
  const sgstPct = Number(invoice.sgstPercent) || 0;
  const igstPct = Number(invoice.igstPercent) || 0;
  const prevDue = Number(invoice.previousDueAmount) || 0;
  const invoiceAmount = Number(invoice.subtotal) - discount + Number(invoice.taxAmount);

  return `
      <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">
        <thead>
          <tr>
            <th style="padding:0 0 8px;border-bottom:2px solid #e2e8f0;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:1px;text-align:left;">Description</th>
            <th style="padding:0 0 8px;border-bottom:2px solid #e2e8f0;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:1px;text-align:right;">Qty</th>
            <th style="padding:0 0 8px 12px;border-bottom:2px solid #e2e8f0;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:1px;text-align:right;">Rate</th>
            <th style="padding:0 0 8px 12px;border-bottom:2px solid #e2e8f0;color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:1px;text-align:right;">Amount</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
          ${totalRow("Subtotal", money(invoice.subtotal, cur))}
          ${discount > 0 ? totalRow("Discount", `− ${money(discount, cur)}`) : ""}
          ${cgstPct > 0 ? totalRow(`CGST (${cgstPct}%)`, money(invoice.cgstAmount, cur)) : ""}
          ${sgstPct > 0 ? totalRow(`SGST (${sgstPct}%)`, money(invoice.sgstAmount, cur)) : ""}
          ${igstPct > 0 ? totalRow(`IGST (${igstPct}%)`, money(invoice.igstAmount, cur)) : ""}
          ${prevDue > 0 ? totalRow("Invoice Amount", money(invoiceAmount, cur), true) : ""}
          ${prevDue > 0 ? totalRow("Previous Due", money(prevDue, cur)) : ""}
          ${totalRow(prevDue > 0 ? "Grand Total" : "Total", money(invoice.total, cur), true)}
        </tbody>
      </table>`;
}

/** Where to pay, from the snapshot frozen onto the invoice. */
function paymentBlock(invoice) {
  const pay = invoice.paymentDetails;
  if (!pay) return "";

  const lines =
    pay.type === "BANK"
      ? [
          ["Bank", pay.bankName],
          ["Account name", pay.accountHolderName],
          ["Account number", pay.accountNumber],
          ["IFSC", pay.ifscCode],
          ["Branch", pay.branch],
        ]
      : [
          ["UPI ID", pay.upiId],
          ["Name", pay.upiName],
        ];

  const rows = lines
    .filter(([, v]) => v)
    .map(
      ([k, v]) => `
        <tr>
          <td style="padding:4px 0;color:#94a3b8;font-size:12px;">${esc(k)}</td>
          <td style="padding:4px 0;color:#334155;font-size:12px;text-align:right;">${esc(v)}</td>
        </tr>`
    )
    .join("");

  if (!rows) return "";

  return `
      <div style="border:1px solid #e2e8f0;border-radius:12px;padding:16px 20px;">
        <p style="margin:0 0 8px;color:#0f172a;font-size:13px;font-weight:600;">Payment details</p>
        <table style="width:100%;border-collapse:collapse;">${rows}</table>
      </div>`;
}

class InvoiceService {
  /**
   * Generate the next invoice number in a series.
   *
   * Each payment account keeps its own run of numbers, so billing from a second
   * bank does not interleave with the first: "INV-2026-0007", "ABC-2026-0001".
   * Invoices with no payment account fall back to the INV series.
   *
   * @param {string} series prefix from the payment account
   * @param {number} attempt retry counter, used to skip a number already taken
   */
  async #nextInvoiceNumber(series = DEFAULT_INVOICE_PREFIX, attempt = 0) {
    const year = new Date().getFullYear();
    const prefix = `${series}-${year}-`;

    // Sort numerically rather than by string: past 9999 a plain desc sort puts
    // "10000" below "9999" and the series would silently restart.
    const rows = await prisma.invoice.findMany({
      where: { invoiceNumber: { startsWith: prefix } },
      select: { invoiceNumber: true },
    });

    let highest = 0;
    for (const row of rows) {
      const n = parseInt(row.invoiceNumber.slice(prefix.length), 10);
      if (!Number.isNaN(n) && n > highest) highest = n;
    }

    return `${prefix}${String(highest + 1 + attempt).padStart(4, "0")}`;
  }

  /**
   * Create an invoice, taking the next number in its series.
   *
   * Numbering is read-then-write, so two invoices created at the same instant
   * can pick the same number. The unique constraint catches that; this retries
   * with the next one instead of failing the request.
   *
   * @param {string} series prefix for the number
   * @param {(invoiceNumber: string) => object} buildArgs prisma create args
   */
  async #createWithNumber(series, buildArgs) {
    const MAX_ATTEMPTS = 5;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const invoiceNumber = await this.#nextInvoiceNumber(series, attempt);
      try {
        return await prisma.invoice.create(buildArgs(invoiceNumber));
      } catch (error) {
        const isDuplicateNumber =
          error?.code === "P2002" &&
          (error.meta?.target || []).some((t) => String(t).includes("invoice_number"));

        if (!isDuplicateNumber || attempt === MAX_ATTEMPTS - 1) throw error;
      }
    }
  }


  /**
   * Email an invoice to the client.
   *
   * A DRAFT moves to SENT once the mail is away — an invoice the client has
   * been asked to pay is no longer a draft. Anything already further along
   * (PAID, OVERDUE) keeps its status, since re-sending a reminder must not
   * walk it backwards.
   */
  async sendToClient(id, { to, cc, bcc, subject, message } = {}, sender) {
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        ...INVOICE_INCLUDE,
        project: { select: { id: true, name: true } },
        client: { select: { companyName: true, email: true } },
      },
    });
    if (!invoice) throw ApiError.notFound("Invoice not found");
    assertActive(invoice);
    if (invoice.status === "CANCELLED") {
      throw ApiError.badRequest("This invoice is cancelled and cannot be sent");
    }

    const recipient = to || invoice.billToEmail || invoice.client?.email;
    if (!recipient) {
      throw ApiError.badRequest(
        "No client email to send to. Add one on the invoice's Bill To details."
      );
    }

    const [site, settings] = await Promise.all([
      prisma.site.findUnique({ where: { id: "default" } }),
      prisma.settings.findUnique({
        where: { id: "default" },
        select: { smtpEmail: true, invoiceBgImage: true, invoiceBgOpacity: true },
      }),
    ]);
    const siteName = site?.name || "TaskGo Agency";

    // Blind-copy the sending mailbox by default, so every invoice that goes out
    // leaves a copy in the agency's own inbox. An explicit "" turns it off.
    const blindCopy = bcc === undefined ? settings?.smtpEmail || null : bcc || null;
    const cur = invoice.currency || "INR";
    const due = Number(invoice.total) - Number(invoice.amountPaid);

    const template = await emailTemplateService.getTemplateBySlug("invoice-sent");
    const rendered = emailTemplateService.renderTemplate(template, {
      siteName,
      senderName: sender ? `${sender.firstName} ${sender.lastName}` : siteName,
      senderEmail: sender?.email || "",
      clientName: invoice.billToName || invoice.client?.companyName || "there",
      invoiceNumber: invoice.invoiceNumber,
      issueDate: emailDate(invoice.issueDate),
      dueDate: emailDate(invoice.dueDate),
      total: money(invoice.total, cur),
      amountDue: money(due, cur),
      projectName: invoice.project?.name || "—",
      message: esc(message || `Please find invoice ${invoice.invoiceNumber} below.`),
      itemsHtml: itemsTable(invoice),
      paymentDetailsHtml: paymentBlock(invoice),
      notes: esc(invoice.notes || ""),
      terms: esc(invoice.terms || ""),
    });

    // The invoice travels as a PDF attachment, so the email body is a summary
    // and the client always has the document itself.
    const pdf = await renderInvoicePdf(invoice, {
      siteName,
      siteAddress: site?.address || null,
      siteEmail: site?.email || null,
      sitePhone: site?.phone || null,
      logo: site?.logo || null,
      watermark: settings?.invoiceBgImage || null,
      watermarkOpacity: settings?.invoiceBgOpacity ?? 0.05,
    });

    await sendMail({
      to: recipient,
      cc: cc || undefined,
      bcc: blindCopy || undefined,
      subject: subject || rendered.subject,
      html: rendered.body,
      attachments: [
        {
          filename: `${invoice.invoiceNumber}.pdf`,
          content: pdf,
          contentType: "application/pdf",
        },
      ],
    });

    // Only a draft advances; a sent/overdue invoice stays where it is.
    if (invoice.status === "DRAFT") {
      await prisma.invoice.update({ where: { id }, data: { status: "SENT" } });
    }

    return { sent: true, to: recipient, cc: cc || null, bcc: blindCopy };
  }

  /**
   * The balance to carry forward onto a new invoice for this project — the
   * outstanding amount (total - amountPaid) on the single most recent
   * non-cancelled invoice. Only the latest one: each invoice's total already
   * embeds whatever it itself carried forward, so summing every past invoice
   * would double-count debt that has already been rolled forward once.
   */
  async #suggestPreviousDue(projectId, excludeInvoiceId = null) {
    const latest = await prisma.invoice.findFirst({
      where: {
        projectId,
        status: { not: "CANCELLED" },
        isActive: true,
        ...(excludeInvoiceId ? { id: { not: excludeInvoiceId } } : {}),
      },
      orderBy: { issueDate: "desc" },
      select: { total: true, amountPaid: true },
    });
    if (!latest) return 0;
    return round2(Math.max(0, Number(latest.total) - Number(latest.amountPaid)));
  }

  /** Read-only: what a new invoice on this project would suggest as previous due. */
  async getPreviousDueSuggestion(projectId) {
    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw ApiError.notFound("Project not found");
    return { previousDueAmount: await this.#suggestPreviousDue(projectId) };
  }

  async createInvoice(data, createdById) {
    const project = await prisma.project.findUnique({
      where: { id: data.projectId },
      include: { client: true },
    });
    if (!project) throw ApiError.notFound("Project not found");

    // Explicit 0 means "no carried balance, on purpose" — only a fully
    // omitted field falls back to the auto-suggestion.
    const previousDueAmount =
      data.previousDueAmount !== undefined
        ? data.previousDueAmount
        : await this.#suggestPreviousDue(data.projectId);

    const {
      lineItems, subtotal, discount,
      cgstPct, sgstPct, igstPct, cgstAmount, sgstAmount, igstAmount,
      taxPct, taxAmount, prevDue, total,
    } = computeTotals(
      data.items,
      data.discountAmount,
      { cgstPercent: data.cgstPercent, sgstPercent: data.sgstPercent, igstPercent: data.igstPercent },
      previousDueAmount
    );

    // The account has to be resolved first — it decides which number series
    // this invoice belongs to.
    const { account, ...paymentFields } = await resolvePaymentAccount(data.paymentAccountId);
    const series = account?.invoicePrefix || DEFAULT_INVOICE_PREFIX;

    const invoice = await this.#createWithNumber(series, (invoiceNumber) => ({
      data: {
        invoiceNumber,
        status: data.status || "DRAFT",
        currency: data.currency || "INR",
        projectId: project.id,
        clientId: project.clientId || null,
        billToName: data.billToName ?? project.client?.companyName ?? null,
        billToEmail: data.billToEmail || project.client?.email || null,
        billToAddress: data.billToAddress ?? project.client?.address ?? null,
        subtotal,
        discountAmount: discount,
        cgstPercent: cgstPct,
        sgstPercent: sgstPct,
        igstPercent: igstPct,
        cgstAmount, sgstAmount, igstAmount,
        taxPercent: taxPct,
        taxAmount,
        previousDueAmount: prevDue,
        total,
        amountPaid: 0,
        issueDate: data.issueDate ? new Date(data.issueDate) : new Date(),
        dueDate: data.dueDate ? new Date(data.dueDate) : null,
        notes: data.notes || null,
        terms: data.terms || null,
        ...paymentFields,
        createdById,
        items: { create: lineItems },
      },
      include: INVOICE_INCLUDE,
    }));

    // Notify the client's portal users (in-app) — fire-and-forget.
    this.#notifyClientOfInvoice(invoice, project).catch((err) =>
      console.error("[InvoiceService] client notify failed:", err.message)
    );

    return invoice;
  }

  /**
   * In-app notification to CLIENT-role users linked to the invoice's client.
   */
  async #notifyClientOfInvoice(invoice, project) {
    if (!project.clientId) return;

    const portalUsers = await prisma.user.findMany({
      where: { clientId: project.clientId, role: "CLIENT", status: "ACTIVE" },
      select: { id: true },
    });
    if (portalUsers.length === 0) return;

    await notificationService.sendBulk({
      userIds: portalUsers.map((u) => u.id),
      title: `New invoice ${invoice.invoiceNumber}`,
      description: `An invoice for project "${project.name}" is now available to view.`,
      type: "INFO",
      channel: "IN_APP",
      linkUrl: `/client/projects/${project.id}`,
    });
  }

  async listInvoices(filters = {}, user = null) {
    const { page = 1, limit = 10, status, projectId, clientId, search, active } = filters;
    const skip = (page - 1) * limit;

    const where = {};
    // Inactive invoices exist only for OWNER/ADMIN. Everyone else gets active
    // ones regardless of what the query asks for.
    if (!canSeeInactive(user)) where.isActive = true;
    else if (active === "active") where.isActive = true;
    else if (active === "inactive") where.isActive = false;
    if (status) where.status = status;
    if (projectId) where.projectId = projectId;
    if (clientId) where.clientId = clientId;
    if (search) {
      where.OR = [
        { invoiceNumber: { contains: search, mode: "insensitive" } },
        { billToName: { contains: search, mode: "insensitive" } },
        { project: { name: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: INVOICE_INCLUDE,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.invoice.count({ where }),
    ]);

    return {
      invoices,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getInvoiceById(id, user = null) {
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: INVOICE_INCLUDE,
    });
    if (!invoice) throw ApiError.notFound("Invoice not found");

    // Indistinguishable from "does not exist" to anyone who may not see it.
    if (!invoice.isActive && !canSeeInactive(user)) {
      throw ApiError.notFound("Invoice not found");
    }

    // CLIENT users may only view finalized invoices for their own client.
    if (user?.role === "CLIENT") {
      if (!user.clientId || invoice.clientId !== user.clientId || invoice.status === "DRAFT") {
        throw ApiError.notFound("Invoice not found");
      }
    }
    return invoice;
  }

  /**
   * All invoices for the logged-in CLIENT user's company (drafts hidden).
   */
  async listMyInvoices(user) {
    if (user?.role !== "CLIENT" || !user.clientId) return { invoices: [], totals: { total: 0, paid: 0, due: 0 } };

    const invoices = await prisma.invoice.findMany({
      where: { clientId: user.clientId, status: { not: "DRAFT" }, isActive: true },
      include: INVOICE_INCLUDE,
      orderBy: { issueDate: "desc" },
    });

    const totals = invoices.reduce(
      (acc, i) => {
        if (i.status === "CANCELLED") return acc;
        acc.total += Number(i.total);
        acc.paid += Number(i.amountPaid);
        return acc;
      },
      { total: 0, paid: 0 }
    );
    totals.due = round2(totals.total - totals.paid);
    totals.total = round2(totals.total);
    totals.paid = round2(totals.paid);

    return { invoices, totals };
  }

  async getInvoicesByProject(projectId, user = null) {
    const where = { projectId };
    if (!canSeeInactive(user)) where.isActive = true;

    // CLIENT users: restrict to their own client + hide drafts.
    if (user?.role === "CLIENT") {
      if (!user.clientId) return [];
      where.clientId = user.clientId;
      where.status = { not: "DRAFT" };
    }

    return prisma.invoice.findMany({
      where,
      include: INVOICE_INCLUDE,
      orderBy: { createdAt: "desc" },
    });
  }

  async updateInvoice(id, data) {
    const existing = await prisma.invoice.findUnique({ where: { id } });
    if (!existing) throw ApiError.notFound("Invoice not found");
    assertActive(existing);

    // A paid or cancelled invoice is locked — block content edits.
    // (A pure amountPaid update, e.g. reconciliation, is still allowed.)
    const isContentEdit =
      data.items !== undefined || data.discountAmount !== undefined ||
      data.cgstPercent !== undefined || data.sgstPercent !== undefined || data.igstPercent !== undefined ||
      data.previousDueAmount !== undefined ||
      data.billToName !== undefined || data.billToEmail !== undefined || data.billToAddress !== undefined ||
      data.notes !== undefined || data.terms !== undefined || data.issueDate !== undefined ||
      data.dueDate !== undefined || data.currency !== undefined;
    if (isContentEdit && ["PAID", "CANCELLED"].includes(existing.status)) {
      throw ApiError.badRequest(`A ${existing.status.toLowerCase()} invoice cannot be edited`);
    }

    const updateData = {};
    if (data.status !== undefined) updateData.status = data.status;
    if (data.currency !== undefined) updateData.currency = data.currency;
    if (data.billToName !== undefined) updateData.billToName = data.billToName;
    if (data.billToEmail !== undefined) updateData.billToEmail = data.billToEmail || null;
    if (data.billToAddress !== undefined) updateData.billToAddress = data.billToAddress;
    if (data.issueDate !== undefined) updateData.issueDate = data.issueDate ? new Date(data.issueDate) : existing.issueDate;
    if (data.dueDate !== undefined) updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;
    if (data.notes !== undefined) updateData.notes = data.notes;
    // Changing the account re-snapshots it, so the invoice always shows the
    // details that were current when it was last edited.
    if (data.paymentAccountId !== undefined) {
      // `account` is only there for the number series, which is fixed at
      // creation — an issued invoice never gets renumbered.
      const { account: _account, ...paymentFields } = await resolvePaymentAccount(data.paymentAccountId);
      Object.assign(updateData, paymentFields);
    }
    if (data.terms !== undefined) updateData.terms = data.terms;

    // If line items / discount / tax / carried-due change → recompute totals.
    // previousDueAmount is never re-suggested on an edit — only createInvoice
    // auto-computes it; here it just carries forward whatever was there.
    const discountAmount = data.discountAmount !== undefined ? data.discountAmount : Number(existing.discountAmount);
    const gst = {
      cgstPercent: data.cgstPercent !== undefined ? data.cgstPercent : Number(existing.cgstPercent),
      sgstPercent: data.sgstPercent !== undefined ? data.sgstPercent : Number(existing.sgstPercent),
      igstPercent: data.igstPercent !== undefined ? data.igstPercent : Number(existing.igstPercent),
    };
    const previousDueAmount =
      data.previousDueAmount !== undefined ? data.previousDueAmount : Number(existing.previousDueAmount);

    const recomputeTriggers =
      data.discountAmount !== undefined || data.cgstPercent !== undefined ||
      data.sgstPercent !== undefined || data.igstPercent !== undefined || data.previousDueAmount !== undefined;

    if (data.items !== undefined) {
      const {
        lineItems, subtotal, discount,
        cgstPct, sgstPct, igstPct, cgstAmount, sgstAmount, igstAmount,
        taxPct, taxAmount, prevDue, total,
      } = computeTotals(data.items, discountAmount, gst, previousDueAmount);
      updateData.subtotal = subtotal;
      updateData.discountAmount = discount;
      updateData.cgstPercent = cgstPct;
      updateData.sgstPercent = sgstPct;
      updateData.igstPercent = igstPct;
      updateData.cgstAmount = cgstAmount;
      updateData.sgstAmount = sgstAmount;
      updateData.igstAmount = igstAmount;
      updateData.taxPercent = taxPct;
      updateData.taxAmount = taxAmount;
      updateData.previousDueAmount = prevDue;
      updateData.total = total;
      // Replace items atomically
      updateData.items = { deleteMany: {}, create: lineItems };
    } else if (recomputeTriggers) {
      // Recompute money from existing items
      const items = await prisma.invoiceItem.findMany({ where: { invoiceId: id }, orderBy: { position: "asc" } });
      const {
        subtotal, discount,
        cgstPct, sgstPct, igstPct, cgstAmount, sgstAmount, igstAmount,
        taxPct, taxAmount, prevDue, total,
      } = computeTotals(
        items.map((i) => ({ name: i.name, description: i.description, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice) })),
        discountAmount,
        gst,
        previousDueAmount
      );
      updateData.subtotal = subtotal;
      updateData.discountAmount = discount;
      updateData.cgstPercent = cgstPct;
      updateData.sgstPercent = sgstPct;
      updateData.igstPercent = igstPct;
      updateData.cgstAmount = cgstAmount;
      updateData.sgstAmount = sgstAmount;
      updateData.igstAmount = igstAmount;
      updateData.taxPercent = taxPct;
      updateData.taxAmount = taxAmount;
      updateData.previousDueAmount = prevDue;
      updateData.total = total;
    }

    // amountPaid + auto-status
    if (data.amountPaid !== undefined) {
      updateData.amountPaid = round2(data.amountPaid);
      const totalNow = updateData.total ?? Number(existing.total);
      if (updateData.amountPaid >= totalNow && totalNow > 0) {
        updateData.status = "PAID";
        updateData.paidAt = new Date();
      } else if (updateData.amountPaid > 0) {
        updateData.status = data.status || "PARTIALLY_PAID";
      }
    }

    return prisma.invoice.update({
      where: { id },
      data: updateData,
      include: INVOICE_INCLUDE,
    });
  }

  /**
   * Soft delete. Replaces hard deletion entirely: an invoice is financial
   * history, its payments must stay traceable, and its number must never be
   * freed up for reuse. Deactivating takes it out of every total and hides it
   * from everyone except OWNER/ADMIN, who can reactivate it.
   */
  async deactivateInvoice(id, user, reason = null) {
    const existing = await prisma.invoice.findUnique({ where: { id }, select: { id: true, isActive: true } });
    if (!existing) throw ApiError.notFound("Invoice not found");
    if (!existing.isActive) throw ApiError.badRequest("This invoice is already inactive");

    return prisma.invoice.update({
      where: { id },
      data: {
        isActive: false,
        deactivatedAt: new Date(),
        deactivatedById: user?.id || null,
        deactivationReason: reason?.trim() || null,
      },
      include: INVOICE_INCLUDE,
    });
  }

  async reactivateInvoice(id) {
    const existing = await prisma.invoice.findUnique({ where: { id }, select: { id: true, isActive: true } });
    if (!existing) throw ApiError.notFound("Invoice not found");
    if (existing.isActive) throw ApiError.badRequest("This invoice is already active");

    return prisma.invoice.update({
      where: { id },
      data: { isActive: true, deactivatedAt: null, deactivatedById: null, deactivationReason: null },
      include: INVOICE_INCLUDE,
    });
  }

  // ─── Payments ────────────────────────────────────────

  /**
   * Recompute an invoice from its payment records.
   *
   * `amountPaid` is never written directly by this path — it is the sum of
   * receipts, so removing a wrongly-entered payment corrects the invoice too.
   */
  async #syncFromPayments(tx, invoiceId) {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      select: { total: true, status: true },
    });

    const agg = await tx.invoicePayment.aggregate({
      where: { invoiceId },
      _sum: { amount: true },
      _max: { paidAt: true },
    });

    const paid = round2(Number(agg._sum.amount || 0));
    const total = Number(invoice.total);

    let status = invoice.status;
    let paidAt = null;

    if (paid <= 0) {
      // Back to whatever it was before money arrived.
      status = ["PAID", "PARTIALLY_PAID"].includes(invoice.status) ? "SENT" : invoice.status;
    } else if (paid >= total && total > 0) {
      status = "PAID";
      paidAt = agg._max.paidAt;
    } else {
      status = "PARTIALLY_PAID";
    }

    await tx.invoice.update({
      where: { id: invoiceId },
      data: { amountPaid: paid, status, paidAt },
    });
  }

  /**
   * Record money received against an invoice.
   *
   * @param {string} id
   * @param {object} data  { amount, method, paidAt, referenceNo, details, note }
   * @param {string} userId
   */
  async addPayment(id, data, userId) {
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: { id: true, total: true, amountPaid: true, status: true, isActive: true },
    });
    if (!invoice) throw ApiError.notFound("Invoice not found");
    assertActive(invoice);
    if (invoice.status === "CANCELLED") {
      throw ApiError.badRequest("A cancelled invoice cannot take payments");
    }

    const amount = round2(data.amount);
    if (!(amount > 0)) throw ApiError.badRequest("Payment amount must be more than zero");

    const outstanding = round2(Number(invoice.total) - Number(invoice.amountPaid));
    if (amount > outstanding) {
      throw ApiError.badRequest(
        `That is more than the ${outstanding.toFixed(2)} still outstanding on this invoice`
      );
    }

    // Method-specific details are what make a receipt traceable later.
    const details = data.details || {};
    const missing = (REQUIRED_BY_METHOD[data.method] || [])
      .filter(([field]) => !String(data[field] ?? details[field] ?? "").trim())
      .map(([, label]) => label);
    if (missing.length > 0) {
      throw ApiError.badRequest(`Missing for this payment method: ${missing.join(", ")}`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.invoicePayment.create({
        data: {
          invoiceId: id,
          amount,
          method: data.method,
          paidAt: data.paidAt ? new Date(data.paidAt) : new Date(),
          referenceNo: data.referenceNo?.trim() || null,
          details: Object.keys(details).length > 0 ? details : null,
          note: data.note?.trim() || null,
          recordedById: userId,
        },
      });
      await this.#syncFromPayments(tx, id);
    });

    return prisma.invoice.findUnique({ where: { id }, include: INVOICE_INCLUDE });
  }

  /** Remove a wrongly-entered receipt; the invoice re-derives from what is left. */
  async removePayment(invoiceId, paymentId) {
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { isActive: true } });
    if (!invoice) throw ApiError.notFound("Invoice not found");
    assertActive(invoice);

    const payment = await prisma.invoicePayment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.invoiceId !== invoiceId) {
      throw ApiError.notFound("Payment not found on this invoice");
    }

    await prisma.$transaction(async (tx) => {
      await tx.invoicePayment.delete({ where: { id: paymentId } });
      await this.#syncFromPayments(tx, invoiceId);
    });

    return prisma.invoice.findUnique({ where: { id: invoiceId }, include: INVOICE_INCLUDE });
  }
}

export default new InvoiceService();
