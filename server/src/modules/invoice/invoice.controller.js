import catchAsync from "../../utils/catchAsync.js";
import { ok, created } from "../../utils/apiResponse.js";
import invoiceService from "./invoice.service.js";

const createInvoice = catchAsync(async (req, res) => {
  const invoice = await invoiceService.createInvoice(req.body, req.user.id);
  return created(res, "Invoice created successfully", invoice);
});

const listInvoices = catchAsync(async (req, res) => {
  const result = await invoiceService.listInvoices(req.query, req.user);
  return ok(res, "Invoices retrieved", result);
});

const getInvoice = catchAsync(async (req, res) => {
  const invoice = await invoiceService.getInvoiceById(req.params.id, req.user);
  return ok(res, "Invoice retrieved", invoice);
});

const listMyInvoices = catchAsync(async (req, res) => {
  const result = await invoiceService.listMyInvoices(req.user);
  return ok(res, "My invoices", result);
});

const getInvoicesByProject = catchAsync(async (req, res) => {
  const invoices = await invoiceService.getInvoicesByProject(req.params.projectId, req.user);
  return ok(res, "Project invoices retrieved", invoices);
});

const getPreviousDueSuggestion = catchAsync(async (req, res) => {
  const result = await invoiceService.getPreviousDueSuggestion(req.params.projectId);
  return ok(res, "Previous due suggestion retrieved", result);
});

const updateInvoice = catchAsync(async (req, res) => {
  const invoice = await invoiceService.updateInvoice(req.params.id, req.body);
  return ok(res, "Invoice updated successfully", invoice);
});

const deactivateInvoice = catchAsync(async (req, res) => {
  const invoice = await invoiceService.deactivateInvoice(req.params.id, req.user, req.body?.reason);
  return ok(res, "Invoice marked inactive", invoice);
});

const reactivateInvoice = catchAsync(async (req, res) => {
  const invoice = await invoiceService.reactivateInvoice(req.params.id);
  return ok(res, "Invoice reactivated", invoice);
});

const addPayment = catchAsync(async (req, res) => {
  const invoice = await invoiceService.addPayment(req.params.id, req.body, req.user.id);
  return ok(res, "Payment recorded", invoice);
});

const deletePayment = catchAsync(async (req, res) => {
  const invoice = await invoiceService.removePayment(req.params.id, req.params.paymentId);
  return ok(res, "Payment removed", invoice);
});

const sendInvoice = catchAsync(async (req, res) => {
  const result = await invoiceService.sendToClient(req.params.id, req.body, req.user);
  return ok(res, `Invoice emailed to ${result.to}`, result);
});

export default {
  createInvoice,
  listInvoices,
  getInvoice,
  listMyInvoices,
  getInvoicesByProject,
  getPreviousDueSuggestion,
  updateInvoice,
  deactivateInvoice,
  reactivateInvoice,
  addPayment,
  deletePayment,
  sendInvoice,
};

