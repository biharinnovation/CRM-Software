"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ReceiptText, Plus, Eye, Loader2 } from "lucide-react";
import { useSite } from "@/context/SiteContext";
import { getInvoicesByProject } from "@/actions/invoices.action";

const STATUS_STYLES = {
  DRAFT: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  SENT: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  PAID: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  PARTIALLY_PAID: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  OVERDUE: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  CANCELLED: "bg-slate-100 text-slate-400 line-through dark:bg-slate-800",
};

/**
 * Invoices card for a project detail page.
 *
 * @param {string}  projectId
 * @param {string}  basePath   role base, e.g. "/owner", "/sales", "/accounts", "/client"
 * @param {boolean} readOnly   clients: view only (no create), and drafts are hidden server-side
 */
export default function ProjectInvoicesSection({ projectId, basePath, readOnly = false }) {
  const router = useRouter();
  const { format } = useSite();
  const [invoices, setInvoices] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const res = await getInvoicesByProject(projectId);
      if (res.success) setInvoices(res.data || []);
      setLoading(false);
    })();
  }, [projectId]);

  // For clients with no invoices, hide the whole card (keeps their view clean).
  if (readOnly && !loading && invoices.length === 0) return null;

  return (
    <div className="bg-white dark:bg-slate-950 rounded-[24px] p-6 lg:p-8 border border-slate-100 dark:border-slate-800 shadow-sm dark:shadow-none shadow-slate-200/50">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700/50 flex items-center justify-center">
            <ReceiptText className="w-5 h-5 text-slate-500 dark:text-slate-400" />
          </div>
          <h3 className="text-lg font-bold text-slate-900 dark:text-slate-50">Invoices</h3>
        </div>
        {!readOnly && (
          <button
            onClick={() => router.push(`${basePath}/invoices/create?projectId=${projectId}`)}
            className="inline-flex items-center gap-2 px-3 py-1.5 bg-[#5542F6] text-white text-xs font-semibold rounded-xl hover:bg-[#4636d4] transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> New Invoice
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
      ) : invoices.length === 0 ? (
        <p className="text-sm text-slate-400 italic">No invoices for this project yet.</p>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {invoices.map((inv) => (
            <button
              key={inv.id}
              onClick={() => router.push(`${basePath}/invoices/${inv.id}`)}
              className={`w-full flex items-center justify-between gap-3 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-900/50 -mx-2 px-2 rounded-lg transition-colors ${
                inv.isActive === false ? "opacity-60" : ""
              }`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-mono text-sm text-slate-900 dark:text-slate-50">{inv.invoiceNumber}</span>
                <span className={`px-2 py-0.5 rounded-md text-xs font-medium ${STATUS_STYLES[inv.status] || ""}`}>
                  {inv.status.replace("_", " ")}
                </span>
                {/* Only Owner/Admin ever receive inactive invoices from the server. */}
                {inv.isActive === false && (
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                    Inactive
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4 shrink-0">
                <span className="text-xs text-slate-400">{new Date(inv.issueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</span>
                <span className="font-semibold text-slate-900 dark:text-slate-50">{format(inv.total)}</span>
                <Eye className="w-4 h-4 text-slate-400" />
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
