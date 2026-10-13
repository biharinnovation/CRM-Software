/**
 * API Utility — centralised HTTP client for TaskGo backend.
 * Uses NEXT_PUBLIC_SERVER_URL from env for the base URL.
 * Provides typed helpers for every auth & resource endpoint.
 */

const BASE_URL = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:4444";

/**
 * Core request helper.
 * Automatically attaches JSON headers and parses the response.
 * Throws a structured error on non-2xx status.
 */
async function request(endpoint, options = {}) {
  const { token, ...fetchOptions } = options;

  const headers = {
    "Content-Type": "application/json",
    ...(token && { Authorization: `Bearer ${token}` }),
    ...options.headers,
  };

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...fetchOptions,
    headers,
  });

  const data = await res.json();

  if (!res.ok) {
    console.log(data.message.toLowerCase());

    if (data.message.toLowerCase().includes("under maintenance")) {
      if (typeof window !== "undefined") {
        window.location.href = "/maintenance";
        return new Promise(() => { });
      }
    }
    
    const error = new Error(data.message || "Something went wrong");
    error.status = res.status;
    error.data = data;
    throw error;
  }

  return data;
}

/* ───────── Auth Endpoints ───────── */

export async function loginAPI(email, password) {
  return request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function refreshTokenAPI(refreshToken) {
  return request("/api/auth/refresh-token", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });
}

export async function logoutAPI(refreshToken, accessToken) {
  return request("/api/auth/logout", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
    token: accessToken,
  });
}

export async function getMeAPI(accessToken) {
  return request("/api/auth/me", {
    method: "GET",
    token: accessToken,
  });
}

export async function changePasswordAPI(accessToken, currentPassword, newPassword) {
  return request("/api/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword }),
    token: accessToken,
  });
}

export async function verifyOtpAPI(userId, otpCode) {
  return request("/api/auth/verify-otp", {
    method: "POST",
    body: JSON.stringify({ userId, otpCode }),
  });
}

export async function resendOtpAPI(userId) {
  return request("/api/auth/resend-otp", {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

export async function updateProfileAPI(data, accessToken) {
  return request("/api/auth/profile", {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function forgotPasswordAPI(email) {
  return request("/api/auth/forgot-password", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function resetPasswordAPI_OTP(email, otpCode, newPassword) {
  return request("/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ email, otpCode, newPassword }),
  });
}

/* ───────── Site Endpoint ───────── */

export async function getSiteAPI() {
  return request("/api/site", { method: "GET", cache: "no-store" });
}

export async function updateSiteAPI(data, accessToken) {
  return request("/api/site", {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

/* ───────── Settings Endpoints ───────── */

export async function getSettingsAPI(accessToken) {
  return request("/api/settings", {
    method: "GET",
    token: accessToken,
  });
}

export async function updateSettingsAPI(data, accessToken) {
  return request("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function getAiSettings(accessToken) {
  return request("/api/settings/ai", {
    method: "GET",
    token: accessToken,
  });
}

export async function getInvoiceConfigAPI(accessToken) {
  return request("/api/settings/invoice-config", {
    method: "GET",
    token: accessToken,
  });
}

/* ───────── Dashboard Endpoint ───────── */

export async function getDashboardStatsAPI(accessToken, period = "month") {
  const query = period ? `?period=${period}` : "";
  return request(`/api/dashboard/stats${query}`, {
    method: "GET",
    token: accessToken,
  });
}

export async function getClientDashboardStatsAPI(accessToken) {
  return request("/api/dashboard/client-stats", {
    method: "GET",
    token: accessToken,
  });
}

export async function getEmployeeDashboardStatsAPI(accessToken) {
  return request("/api/dashboard/employee-stats", {
    method: "GET",
    token: accessToken,
  });
}

export async function getSalesDashboardStatsAPI(accessToken) {
  return request("/api/dashboard/sales-stats", {
    method: "GET",
    token: accessToken,
  });
}

export async function getAccountDashboardStatsAPI(accessToken) {
  return request("/api/dashboard/account-stats", {
    method: "GET",
    token: accessToken,
  });
}

/* ───────── Client Endpoints ───────── */

export async function getClientsAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/clients?${query}`, { method: "GET", token: accessToken });
}

export async function getClientAPI(id, accessToken) {
  return request(`/api/clients/${id}`, { method: "GET", token: accessToken });
}

export async function createClientAPI(data, accessToken) {
  return request("/api/clients", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateClientAPI(id, data, accessToken) {
  return request(`/api/clients/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteClientAPI(id, accessToken) {
  return request(`/api/clients/${id}`, { method: "DELETE", token: accessToken });
}

export async function getClientsDropdownAPI(accessToken) {
  return request("/api/clients/dropdown", { method: "GET", token: accessToken });
}

/* ───────── Project Endpoints ───────── */

export async function getProjectsAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/projects?${query}`, { method: "GET", token: accessToken });
}

export async function getProjectAPI(id, accessToken) {
  return request(`/api/projects/${id}`, { method: "GET", token: accessToken });
}

export async function createProjectAPI(data, accessToken) {
  return request("/api/projects", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateProjectAPI(id, data, accessToken) {
  return request(`/api/projects/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteProjectAPI(id, accessToken) {
  return request(`/api/projects/${id}`, { method: "DELETE", token: accessToken });
}

export async function addProjectServicesAPI(projectId, services, accessToken) {
  return request(`/api/projects/${projectId}/services`, {
    method: "POST",
    body: JSON.stringify({ services }),
    token: accessToken,
  });
}

export async function updateProjectServiceAPI(projectId, serviceId, data, accessToken) {
  return request(`/api/projects/${projectId}/services/${serviceId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function removeProjectServiceAPI(projectId, serviceId, accessToken) {
  return request(`/api/projects/${projectId}/services/${serviceId}`, {
    method: "DELETE",
    token: accessToken,
  });
}

export async function reorderProjectServicesAPI(projectId, orderedIds, accessToken) {
  return request(`/api/projects/${projectId}/services/reorder`, {
    method: "PATCH",
    body: JSON.stringify({ orderedIds }),
    token: accessToken,
  });
}

export async function addProjectPackageAPI(projectId, packageId, accessToken) {
  return request(`/api/projects/${projectId}/packages`, {
    method: "POST",
    body: JSON.stringify({ packageId }),
    token: accessToken,
  });
}

export async function removeProjectPackageAPI(projectId, packageId, accessToken) {
  return request(`/api/projects/${projectId}/packages/${packageId}`, {
    method: "DELETE",
    token: accessToken,
  });
}

/* ───────── User Endpoints ───────── */

export async function getUsersAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/users?${query}`, { method: "GET", token: accessToken });
}

export async function getUserAPI(id, accessToken) {
  return request(`/api/users/${id}`, { method: "GET", token: accessToken });
}

export async function getUserReportAPI(id, accessToken) {
  return request(`/api/users/${id}/report`, { method: "GET", token: accessToken });
}

export async function createUserAPI(data, accessToken) {
  return request("/api/users", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateUserAPI(id, data, accessToken) {
  return request(`/api/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteUserAPI(id, accessToken) {
  return request(`/api/users/${id}`, { method: "DELETE", token: accessToken });
}

export async function resetPasswordAPI(id, newPassword, accessToken) {
  return request(`/api/users/${id}/reset-password`, {
    method: "POST",
    body: JSON.stringify({ newPassword }),
    token: accessToken,
  });
}

/* ───────── Lead Endpoints ───────── */

export async function getLeadsAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/leads?${query}`, { method: "GET", token: accessToken });
}

export async function getLeadAPI(id, accessToken) {
  return request(`/api/leads/${id}`, { method: "GET", token: accessToken });
}

export async function createLeadAPI(data, accessToken) {
  return request("/api/leads", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateLeadAPI(id, data, accessToken) {
  return request(`/api/leads/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateLeadStatusAPI(id, data, accessToken) {
  return request(`/api/leads/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteLeadAPI(id, accessToken) {
  return request(`/api/leads/${id}`, { method: "DELETE", token: accessToken });
}

/* ───────── Deal Endpoints ───────── */

export async function getDealsAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/deals?${query}`, { method: "GET", token: accessToken });
}

export async function getDealAPI(id, accessToken) {
  return request(`/api/deals/${id}`, { method: "GET", token: accessToken });
}

export async function createDealAPI(data, accessToken) {
  return request("/api/deals", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateDealAPI(id, data, accessToken) {
  return request(`/api/deals/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateDealStageAPI(id, data, accessToken) {
  return request(`/api/deals/${id}/stage`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteDealAPI(id, accessToken) {
  return request(`/api/deals/${id}`, { method: "DELETE", token: accessToken });
}

export async function addDealServicesAPI(dealId, services, accessToken) {
  return request(`/api/deals/${dealId}/services`, {
    method: "POST",
    body: JSON.stringify({ services }),
    token: accessToken,
  });
}

export async function removeDealServiceAPI(dealId, serviceId, accessToken) {
  return request(`/api/deals/${dealId}/services/${serviceId}`, {
    method: "DELETE",
    token: accessToken,
  });
}

export async function addDealPackageAPI(dealId, packageId, accessToken) {
  return request(`/api/deals/${dealId}/packages`, {
    method: "POST",
    body: JSON.stringify({ packageId }),
    token: accessToken,
  });
}

export async function removeDealPackageAPI(dealId, packageId, accessToken) {
  return request(`/api/deals/${dealId}/packages/${packageId}`, {
    method: "DELETE",
    token: accessToken,
  });
}

/* ───────── Email Template Endpoints ───────── */

export async function getEmailTemplatesAPI(accessToken) {
  return request("/api/email-templates", { method: "GET", token: accessToken });
}

export async function getEmailTemplateAPI(id, accessToken) {
  return request(`/api/email-templates/${id}`, { method: "GET", token: accessToken });
}

export async function updateEmailTemplateAPI(id, data, accessToken) {
  return request(`/api/email-templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

/* ───────── Service Endpoints ───────── */

export async function getServicesAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/services?${query}`, { method: "GET", token: accessToken });
}

export async function getServiceAPI(id, accessToken) {
  return request(`/api/services/${id}`, { method: "GET", token: accessToken });
}

export async function createServiceAPI(data, accessToken) {
  return request("/api/services", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateServiceAPI(id, data, accessToken) {
  return request(`/api/services/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteServiceAPI(id, accessToken) {
  return request(`/api/services/${id}`, { method: "DELETE", token: accessToken });
}

export async function getServicesDropdownAPI(accessToken) {
  return request("/api/services/dropdown", { method: "GET", token: accessToken });
}

/* ───────── Service Packages ───────── */

export async function getPackagesAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/packages?${query}`, { method: "GET", token: accessToken });
}

export async function getPackageAPI(id, accessToken) {
  return request(`/api/packages/${id}`, { method: "GET", token: accessToken });
}

export async function createPackageAPI(data, accessToken) {
  return request("/api/packages", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updatePackageAPI(id, data, accessToken) {
  return request(`/api/packages/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deletePackageAPI(id, accessToken) {
  return request(`/api/packages/${id}`, { method: "DELETE", token: accessToken });
}

export async function getPackagesDropdownAPI(accessToken) {
  return request("/api/packages/dropdown", { method: "GET", token: accessToken });
}

/* ───────── Storage ───────── */

export async function getUploadConfigAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/storage/upload-config?${query}`, {
    method: "GET",
    token: accessToken,
  });
}

/* ───────── Team Endpoints ───────── */

export async function getTeamsAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/teams?${query}`, { method: "GET", token: accessToken });
}

export async function getTeamAPI(id, accessToken) {
  return request(`/api/teams/${id}`, { method: "GET", token: accessToken });
}

export async function createTeamAPI(data, accessToken) {
  return request("/api/teams", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateTeamAPI(id, data, accessToken) {
  return request(`/api/teams/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteTeamAPI(id, accessToken) {
  return request(`/api/teams/${id}`, { method: "DELETE", token: accessToken });
}

export async function getTeamsDropdownAPI(accessToken) {
  return request("/api/teams/dropdown", { method: "GET", token: accessToken });
}

export async function addTeamMemberAPI(teamId, data, accessToken) {
  return request(`/api/teams/${teamId}/members`, {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function removeTeamMemberAPI(teamId, userId, accessToken) {
  return request(`/api/teams/${teamId}/members/${userId}`, {
    method: "DELETE",
    token: accessToken,
  });
}

export async function updateTeamMemberPermissionsAPI(teamId, userId, permissions, accessToken) {
  return request(`/api/teams/${teamId}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ permissions }),
    token: accessToken,
  });
}

/* ───────── Global Search ───────── */

export async function globalSearchAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/search?${query}`, { method: "GET", token: accessToken });
}

/* ───────── Notifications ───────── */

export async function getNotificationsAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/notifications?${query}`, { method: "GET", token: accessToken });
}

export async function getUnreadCountAPI(accessToken) {
  return request("/api/notifications/unread-count", { method: "GET", token: accessToken });
}

export async function markNotificationReadAPI(id, accessToken) {
  return request(`/api/notifications/${id}/read`, { method: "PATCH", token: accessToken });
}

export async function markAllNotificationsReadAPI(accessToken) {
  return request("/api/notifications/read-all", { method: "PATCH", token: accessToken });
}

export async function deleteNotificationAPI(id, accessToken) {
  return request(`/api/notifications/${id}`, { method: "DELETE", token: accessToken });
}

export async function clearReadNotificationsAPI(accessToken) {
  return request("/api/notifications/clear-read", { method: "DELETE", token: accessToken });
}

/* ───────── System Prompts ───────── */

export async function getSystemPromptsAPI(accessToken) {
  return request("/api/system-prompts", { method: "GET", token: accessToken });
}

export async function getSystemPromptAPI(id, accessToken) {
  return request(`/api/system-prompts/${id}`, { method: "GET", token: accessToken });
}

export async function createSystemPromptAPI(data, accessToken) {
  return request("/api/system-prompts", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateSystemPromptAPI(id, data, accessToken) {
  return request(`/api/system-prompts/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteSystemPromptAPI(id, accessToken) {
  return request(`/api/system-prompts/${id}`, { method: "DELETE", token: accessToken });
}

/* ───────── AI ───────── */

export async function aiGenerateAPI(data, accessToken) {
  return request("/api/ai/generate", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function aiSearchAPI(question, accessToken) {
  return request("/api/ai/search", {
    method: "POST",
    body: JSON.stringify({ question }),
    token: accessToken,
  });
}

/* ───────── Documents ───────── */

export async function getDocumentsAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/documents?${query}`, { method: "GET", token: accessToken });
}

export async function getDocumentAPI(id, accessToken) {
  return request(`/api/documents/${id}`, { method: "GET", token: accessToken });
}

export async function getDocumentsByDealAPI(dealId, accessToken) {
  return request(`/api/documents/deal/${dealId}`, { method: "GET", token: accessToken });
}

export async function getDocumentsByProjectAPI(projectId, accessToken) {
  return request(`/api/documents/project/${projectId}`, { method: "GET", token: accessToken });
}

export async function getDocumentsByUserAPI(userId, accessToken) {
  return request(`/api/documents/user/${userId}`, { method: "GET", token: accessToken });
}

export async function createDocumentAPI(data, accessToken) {
  return request("/api/documents", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateDocumentAPI(id, data, accessToken) {
  return request(`/api/documents/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteDocumentAPI(id, accessToken) {
  return request(`/api/documents/${id}`, { method: "DELETE", token: accessToken });
}

export async function sendDocumentEmailAPI(id, data, accessToken) {
  return request(`/api/documents/${id}/send-email`, {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

/* ───────── Meetings ───────── */

export async function getMeetingsAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/meetings?${query}`, { method: "GET", token: accessToken });
}

export async function getMeetingAPI(id, accessToken) {
  return request(`/api/meetings/${id}`, { method: "GET", token: accessToken });
}

export async function getMeetingsByLeadAPI(leadId, accessToken) {
  return request(`/api/meetings/lead/${leadId}`, { method: "GET", token: accessToken });
}

export async function getMeetingsByDealAPI(dealId, accessToken) {
  return request(`/api/meetings/deal/${dealId}`, { method: "GET", token: accessToken });
}

export async function getMeetingsByProjectAPI(projectId, accessToken) {
  return request(`/api/meetings/project/${projectId}`, { method: "GET", token: accessToken });
}

export async function createMeetingAPI(data, accessToken) {
  return request("/api/meetings", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateMeetingAPI(id, data, accessToken) {
  return request(`/api/meetings/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteMeetingAPI(id, accessToken) {
  return request(`/api/meetings/${id}`, { method: "DELETE", token: accessToken });
}

export async function completePostProductionMeetingAPI(id, data, accessToken) {
  return request(`/api/meetings/${id}/complete-post-production`, {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

/* ───────── Follow-Ups ───────── */

export async function getFollowUpsAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/follow-ups?${query}`, { method: "GET", token: accessToken });
}

export async function getFollowUpAPI(id, accessToken) {
  return request(`/api/follow-ups/${id}`, { method: "GET", token: accessToken });
}

export async function getFollowUpsByLeadAPI(leadId, accessToken) {
  return request(`/api/follow-ups/lead/${leadId}`, { method: "GET", token: accessToken });
}

export async function getFollowUpsByDealAPI(dealId, accessToken) {
  return request(`/api/follow-ups/deal/${dealId}`, { method: "GET", token: accessToken });
}

export async function createFollowUpAPI(data, accessToken) {
  return request("/api/follow-ups", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateFollowUpAPI(id, data, accessToken) {
  return request(`/api/follow-ups/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteFollowUpAPI(id, accessToken) {
  return request(`/api/follow-ups/${id}`, { method: "DELETE", token: accessToken });
}

/* ───────── Samples ───────── */

export async function getSamplesAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/samples?${query}`, { method: "GET", token: accessToken });
}

export async function getSampleAPI(id, accessToken) {
  return request(`/api/samples/${id}`, { method: "GET", token: accessToken });
}

export async function createSampleAPI(data, accessToken) {
  return request("/api/samples", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateSampleAPI(id, data, accessToken) {
  return request(`/api/samples/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteSampleAPI(id, accessToken) {
  return request(`/api/samples/${id}`, { method: "DELETE", token: accessToken });
}

export async function getSamplesDropdownAPI(accessToken) {
  return request("/api/samples/dropdown", { method: "GET", token: accessToken });
}

export async function getSamplesByLeadAPI(leadId, accessToken) {
  return request(`/api/samples/lead/${leadId}`, { method: "GET", token: accessToken });
}

export async function attachSamplesToLeadAPI(leadId, sampleIds, accessToken) {
  return request(`/api/samples/lead/${leadId}`, {
    method: "POST",
    body: JSON.stringify({ sampleIds }),
    token: accessToken,
  });
}

export async function detachSampleFromLeadAPI(leadId, sampleId, accessToken) {
  return request(`/api/samples/lead/${leadId}/${sampleId}`, {
    method: "DELETE",
    token: accessToken,
  });
}

export async function getSamplesByDealAPI(dealId, accessToken) {
  return request(`/api/samples/deal/${dealId}`, { method: "GET", token: accessToken });
}

export async function attachSamplesToDealAPI(dealId, sampleIds, accessToken) {
  return request(`/api/samples/deal/${dealId}`, {
    method: "POST",
    body: JSON.stringify({ sampleIds }),
    token: accessToken,
  });
}

export async function detachSampleFromDealAPI(dealId, sampleId, accessToken) {
  return request(`/api/samples/deal/${dealId}/${sampleId}`, {
    method: "DELETE",
    token: accessToken,
  });
}

/* ───────── Planning Steps ───────── */

export async function getPlanningStepsByProjectAPI(projectId, params, accessToken) {
  const query = params ? new URLSearchParams(params).toString() : "";
  return request(`/api/planning-steps/project/${projectId}${query ? `?${query}` : ""}`, {
    method: "GET", token: accessToken,
  });
}

export async function getPlanningStepAPI(id, accessToken) {
  return request(`/api/planning-steps/${id}`, { method: "GET", token: accessToken });
}

export async function createPlanningStepAPI(data, accessToken) {
  return request("/api/planning-steps", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updatePlanningStepAPI(id, data, accessToken) {
  return request(`/api/planning-steps/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deletePlanningStepAPI(id, accessToken) {
  return request(`/api/planning-steps/${id}`, { method: "DELETE", token: accessToken });
}

export async function reorderPlanningStepsAPI(projectId, stepIds, accessToken) {
  return request(`/api/planning-steps/project/${projectId}/reorder`, {
    method: "PATCH",
    body: JSON.stringify({ stepIds }),
    token: accessToken,
  });
}

/* ───────── Tasks ───────── */

export async function getTasksByProjectAPI(projectId, params, accessToken) {
  const query = params ? new URLSearchParams(params).toString() : "";
  return request(`/api/tasks/project/${projectId}${query ? `?${query}` : ""}`, { method: "GET", token: accessToken });
}

export async function getMyTasksAPI(params, accessToken) {
  const query = params ? new URLSearchParams(params).toString() : "";
  return request(`/api/tasks/my${query ? `?${query}` : ""}`, { method: "GET", token: accessToken });
}

export async function getTaskAPI(id, accessToken) {
  return request(`/api/tasks/${id}`, { method: "GET", token: accessToken });
}

export async function createTaskAPI(data, accessToken) {
  return request("/api/tasks", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateTaskAPI(id, data, accessToken) {
  return request(`/api/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteTaskAPI(id, accessToken) {
  return request(`/api/tasks/${id}`, { method: "DELETE", token: accessToken });
}

export async function bulkUpdateTaskStatusAPI(data, accessToken) {
  return request("/api/tasks/bulk-status", {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function addTaskFeedbackAPI(taskId, data, accessToken) {
  return request(`/api/tasks/${taskId}/feedback`, {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function getAssignableUsersAPI(projectId, accessToken) {
  return request(`/api/tasks/project/${projectId}/assignable-users`, { method: "GET", token: accessToken });
}

export async function getChildTasksAPI(taskId, accessToken) {
  return request(`/api/tasks/${taskId}/children`, { method: "GET", token: accessToken });
}

/* ───────── Milestones ───────── */

export async function getMilestonesByProjectAPI(projectId, params, accessToken) {
  const query = params ? new URLSearchParams(params).toString() : "";
  return request(`/api/milestones/project/${projectId}${query ? `?${query}` : ""}`, {
    method: "GET", token: accessToken,
  });
}

export async function getMilestoneAPI(id, accessToken) {
  return request(`/api/milestones/${id}`, { method: "GET", token: accessToken });
}

export async function createMilestoneAPI(data, accessToken) {
  return request("/api/milestones", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateMilestoneAPI(id, data, accessToken) {
  return request(`/api/milestones/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteMilestoneAPI(id, accessToken) {
  return request(`/api/milestones/${id}`, { method: "DELETE", token: accessToken });
}

export async function reorderMilestonesAPI(projectId, milestoneIds, accessToken) {
  return request(`/api/milestones/project/${projectId}/reorder`, {
    method: "PATCH",
    body: JSON.stringify({ milestoneIds }),
    token: accessToken,
  });
}

/* ───────── Comments ───────── */

export async function createCommentAPI(data, accessToken) {
  return request("/api/comments", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function getCommentsAPI(entityType, entityId, accessToken) {
  return request(`/api/comments/${entityType}/${entityId}`, { method: "GET", token: accessToken });
}

export async function deleteCommentAPI(id, accessToken) {
  return request(`/api/comments/${id}`, { method: "DELETE", token: accessToken });
}

/* ───────── Generic Authenticated Requests ───────── */

export async function apiGet(endpoint, accessToken) {
  return request(endpoint, { method: "GET", token: accessToken });
}

export async function apiPost(endpoint, body, accessToken) {
  return request(endpoint, {
    method: "POST",
    body: JSON.stringify(body),
    token: accessToken,
  });
}

export async function apiPut(endpoint, body, accessToken) {
  return request(endpoint, {
    method: "PUT",
    body: JSON.stringify(body),
    token: accessToken,
  });
}

export async function apiPatch(endpoint, body, accessToken) {
  return request(endpoint, {
    method: "PATCH",
    body: JSON.stringify(body),
    token: accessToken,
  });
}

export async function apiDelete(endpoint, accessToken) {
  return request(endpoint, { method: "DELETE", token: accessToken });
}

/* ───────── Attendance ───────── */

export async function checkInAPI(data, accessToken) {
  return request("/api/attendance/check-in", { method: "POST", body: JSON.stringify(data || {}), token: accessToken });
}

export async function checkOutAPI(data, accessToken) {
  return request("/api/attendance/check-out", { method: "POST", body: JSON.stringify(data || {}), token: accessToken });
}

export async function getTodayAttendanceAPI(accessToken) {
  return request("/api/attendance/today", { method: "GET", token: accessToken });
}

export async function getMyAttendanceAPI(params, accessToken) {
  const q = params ? new URLSearchParams(params).toString() : "";
  return request(`/api/attendance/my${q ? `?${q}` : ""}`, { method: "GET", token: accessToken });
}

export async function getDailyAttendanceSheetAPI(date, accessToken) {
  return request(`/api/attendance/daily?date=${encodeURIComponent(date)}`, { method: "GET", token: accessToken });
}

export async function getUserAttendanceAPI(userId, params, accessToken) {
  const q = params ? new URLSearchParams(params).toString() : "";
  return request(`/api/attendance/user/${userId}${q ? `?${q}` : ""}`, { method: "GET", token: accessToken });
}

export async function manualMarkAttendanceAPI(data, accessToken) {
  return request("/api/attendance", { method: "POST", body: JSON.stringify(data), token: accessToken });
}

export async function updateAttendanceAPI(id, data, accessToken) {
  return request(`/api/attendance/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}

export async function deleteAttendanceAPI(id, accessToken) {
  return request(`/api/attendance/${id}`, { method: "DELETE", token: accessToken });
}

/* ───────── Leave ───────── */

// Types
export async function listLeaveTypesAPI(accessToken) {
  return request("/api/leave/types", { method: "GET", token: accessToken });
}
export async function createLeaveTypeAPI(data, accessToken) {
  return request("/api/leave/types", { method: "POST", body: JSON.stringify(data), token: accessToken });
}
export async function updateLeaveTypeAPI(id, data, accessToken) {
  return request(`/api/leave/types/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}
export async function deleteLeaveTypeAPI(id, accessToken) {
  return request(`/api/leave/types/${id}`, { method: "DELETE", token: accessToken });
}

// Balances
export async function getMyLeaveBalancesAPI(year, accessToken) {
  const q = year ? `?year=${year}` : "";
  return request(`/api/leave/balances/my${q}`, { method: "GET", token: accessToken });
}
export async function getUserLeaveBalancesAPI(userId, year, accessToken) {
  const q = year ? `?year=${year}` : "";
  return request(`/api/leave/balances/user/${userId}${q}`, { method: "GET", token: accessToken });
}
export async function updateLeaveBalanceAPI(id, data, accessToken) {
  return request(`/api/leave/balances/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}
export async function seedLeaveBalancesAPI(year, accessToken) {
  return request(`/api/leave/balances/seed?year=${year}`, { method: "POST", token: accessToken });
}

// Requests
export async function createLeaveRequestAPI(data, accessToken) {
  return request("/api/leave/requests", { method: "POST", body: JSON.stringify(data), token: accessToken });
}
export async function getMyLeaveRequestsAPI(accessToken) {
  return request("/api/leave/requests/my", { method: "GET", token: accessToken });
}
export async function listLeaveRequestsAPI(params, accessToken) {
  const q = params ? new URLSearchParams(params).toString() : "";
  return request(`/api/leave/requests${q ? `?${q}` : ""}`, { method: "GET", token: accessToken });
}
export async function getLeaveRequestAPI(id, accessToken) {
  return request(`/api/leave/requests/${id}`, { method: "GET", token: accessToken });
}
export async function approveLeaveRequestAPI(id, data, accessToken) {
  return request(`/api/leave/requests/${id}/approve`, { method: "PATCH", body: JSON.stringify(data || {}), token: accessToken });
}
export async function rejectLeaveRequestAPI(id, data, accessToken) {
  return request(`/api/leave/requests/${id}/reject`, { method: "PATCH", body: JSON.stringify(data || {}), token: accessToken });
}
export async function cancelLeaveRequestAPI(id, accessToken) {
  return request(`/api/leave/requests/${id}/cancel`, { method: "PATCH", token: accessToken });
}

/* ───────── Holidays ───────── */

export async function listHolidaysAPI(year, accessToken) {
  const q = year ? `?year=${year}` : "";
  return request(`/api/holidays${q}`, { method: "GET", token: accessToken });
}
export async function createHolidayAPI(data, accessToken) {
  return request("/api/holidays", { method: "POST", body: JSON.stringify(data), token: accessToken });
}
export async function updateHolidayAPI(id, data, accessToken) {
  return request(`/api/holidays/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}
export async function deleteHolidayAPI(id, accessToken) {
  return request(`/api/holidays/${id}`, { method: "DELETE", token: accessToken });
}

export async function getProjectLedgerAPI(projectId, accessToken) {
  return request(`/api/projects/${projectId}/ledger`, { method: "GET", token: accessToken });
}

export async function getProjectOptionsAPI(accessToken) {
  return request("/api/projects/options", { method: "GET", token: accessToken });
}

export async function getProjectPermissionsAPI(projectId, accessToken) {
  return request(`/api/projects/${projectId}/permissions`, { method: "GET", token: accessToken });
}

/* ───────── Assignable Staff (any internal role) ───────── */

export async function getAssignableStaffAPI(accessToken) {
  return request("/api/users/assignable", { method: "GET", token: accessToken });
}

/* ───────── User Directory (HR/OWNER/ADMIN) ───────── */

export async function getUserDirectoryAPI(accessToken) {
  return request("/api/users/directory", { method: "GET", token: accessToken });
}

/* ───────── HR Dashboard Stats ───────── */

export async function getFinanceDashboardStatsAPI(accessToken, params) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/dashboard/finance-stats${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

export async function getHrDashboardStatsAPI(accessToken) {
  return request("/api/dashboard/hr-stats", { method: "GET", token: accessToken });
}

export default request;

// --- Calendar ---
export async function getCalendarEventsAPI(accessToken, start, end) {
  let query = "";
  if (start && end) {
    query = `?start=${start}&end=${end}`;
  }
  return request(`/api/calendar/events${query}`, {
    method: "GET",
    token: accessToken,
  });
}

/* ───────── Copilot ───────── */

export async function getCopilotConversationsAPI(accessToken) {
  return request("/api/copilot/conversations", { method: "GET", token: accessToken });
}

export async function getCopilotConversationAPI(id, accessToken) {
  return request(`/api/copilot/conversations/${id}`, { method: "GET", token: accessToken });
}

export async function createCopilotConversationAPI(data, accessToken) {
  return request("/api/copilot/conversations", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateCopilotConversationAPI(id, data, accessToken) {
  return request(`/api/copilot/conversations/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteCopilotConversationAPI(id, accessToken) {
  return request(`/api/copilot/conversations/${id}`, { method: "DELETE", token: accessToken });
}

export async function getCopilotMessagesAPI(conversationId, accessToken) {
  return request(`/api/copilot/messages/${conversationId}`, { method: "GET", token: accessToken });
}

export async function sendCopilotMessageAPI(data, accessToken) {
  return request("/api/copilot/message", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function executeCopilotActionAPI(messageId, actionId, accessToken) {
  return request(`/api/copilot/messages/${messageId}/actions/${actionId}`, {
    method: "POST",
    token: accessToken,
  });
}

export async function getCopilotCapabilitiesAPI(accessToken) {
  return request("/api/copilot/capabilities", { method: "GET", token: accessToken });
}

export async function getCopilotSuggestionsAPI(accessToken) {
  return request("/api/copilot/suggestions", { method: "GET", token: accessToken });
}

/* ───────── Invoices ───────── */

export async function getInvoicesAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/invoices?${query}`, { method: "GET", token: accessToken });
}

export async function getInvoiceAPI(id, accessToken) {
  return request(`/api/invoices/${id}`, { method: "GET", token: accessToken });
}

export async function getMyInvoicesAPI(accessToken) {
  return request("/api/invoices/my", { method: "GET", token: accessToken });
}

export async function getInvoicesByProjectAPI(projectId, accessToken) {
  return request(`/api/invoices/project/${projectId}`, { method: "GET", token: accessToken });
}

export async function getPreviousDueSuggestionAPI(projectId, accessToken) {
  return request(`/api/invoices/project/${projectId}/previous-due`, { method: "GET", token: accessToken });
}

export async function createInvoiceAPI(data, accessToken) {
  return request("/api/invoices", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function updateInvoiceAPI(id, data, accessToken) {
  return request(`/api/invoices/${id}`, {
    method: "PATCH",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

// Invoices are never hard-deleted — they are deactivated (soft delete).
export async function deactivateInvoiceAPI(id, reason, accessToken) {
  return request(`/api/invoices/${id}/deactivate`, {
    method: "PATCH",
    body: JSON.stringify({ reason: reason || null }),
    token: accessToken,
  });
}

export async function reactivateInvoiceAPI(id, accessToken) {
  return request(`/api/invoices/${id}/reactivate`, { method: "PATCH", token: accessToken });
}

/* ───────── Announcements ───────── */

export async function getAnnouncementsAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/announcements?${query}`, { method: "GET", token: accessToken });
}

export async function createAnnouncementAPI(data, accessToken) {
  return request("/api/announcements", {
    method: "POST",
    body: JSON.stringify(data),
    token: accessToken,
  });
}

export async function deleteAnnouncementAPI(id, accessToken) {
  return request(`/api/announcements/${id}`, { method: "DELETE", token: accessToken });
}

/* ───────── Jobs (HR-managed) ───────── */

export async function getJobsAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/jobs?${query}`, { method: "GET", token: accessToken });
}
export async function getJobAPI(id, accessToken) {
  return request(`/api/jobs/${id}`, { method: "GET", token: accessToken });
}
export async function createJobAPI(data, accessToken) {
  return request("/api/jobs", { method: "POST", body: JSON.stringify(data), token: accessToken });
}
export async function updateJobAPI(id, data, accessToken) {
  return request(`/api/jobs/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}
export async function deleteJobAPI(id, accessToken) {
  return request(`/api/jobs/${id}`, { method: "DELETE", token: accessToken });
}
export async function getJobApplicationsAPI(id, accessToken) {
  return request(`/api/jobs/${id}/applications`, { method: "GET", token: accessToken });
}
export async function updateJobApplicationAPI(id, data, accessToken) {
  return request(`/api/jobs/applications/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}

/* ───────── Jobs (public — no auth) ───────── */

export async function getPublicJobsAPI() {
  return request("/api/jobs/public", { method: "GET" });
}
export async function getPublicJobAPI(slug) {
  return request(`/api/jobs/public/${slug}`, { method: "GET" });
}
export async function applyToJobAPI(slug, data) {
  return request(`/api/jobs/public/${slug}/apply`, { method: "POST", body: JSON.stringify(data) });
}
export async function getPublicUploadConfigAPI(params) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/storage/public/upload-config?${query}`, { method: "GET" });
}

/* ───────── Payroll & KPI ───────── */

export async function getKpiConfigAPI(accessToken) {
  return request("/api/payroll/config", { method: "GET", token: accessToken });
}
export async function updateKpiConfigAPI(data, accessToken) {
  return request("/api/payroll/config", { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}
export async function generatePayrollAPI(data, accessToken) {
  return request("/api/payroll/generate", { method: "POST", body: JSON.stringify(data), token: accessToken });
}
export async function getPayrollAPI(params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/payroll?${query}`, { method: "GET", token: accessToken });
}
export async function getPayrollRecordAPI(id, accessToken) {
  return request(`/api/payroll/${id}`, { method: "GET", token: accessToken });
}
export async function previewPayrollAPI(userId, params, accessToken) {
  const query = new URLSearchParams(params).toString();
  return request(`/api/payroll/preview/${userId}?${query}`, { method: "GET", token: accessToken });
}
export async function setUserBasePayAPI(userId, basePay, accessToken) {
  return request(`/api/payroll/base-pay/${userId}`, { method: "PATCH", body: JSON.stringify({ basePay }), token: accessToken });
}
export async function getPayrollHistoryAPI(userId, accessToken) {
  return request(`/api/payroll/history/${userId}`, { method: "GET", token: accessToken });
}
export async function updatePayrollRecordAPI(id, data, accessToken) {
  return request(`/api/payroll/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}
export async function deletePayrollRecordAPI(id, accessToken) {
  return request(`/api/payroll/${id}`, { method: "DELETE", token: accessToken });
}

/* ───────── Deliverables ───────── */

export async function getProjectDeliverablesAPI(projectId, accessToken) {
  return request(`/api/deliverables/project/${projectId}`, { method: "GET", token: accessToken });
}
export async function getDeliverableAPI(id, accessToken) {
  return request(`/api/deliverables/${id}`, { method: "GET", token: accessToken });
}
export async function createDeliverableAPI(data, accessToken) {
  return request("/api/deliverables", { method: "POST", body: JSON.stringify(data), token: accessToken });
}
export async function updateDeliverableAPI(id, data, accessToken) {
  return request(`/api/deliverables/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}
export async function deleteDeliverableAPI(id, accessToken) {
  return request(`/api/deliverables/${id}`, { method: "DELETE", token: accessToken });
}
export async function addDeliverableFeedbackAPI(id, data, accessToken) {
  return request(`/api/deliverables/${id}/feedback`, { method: "POST", body: JSON.stringify(data), token: accessToken });
}

/* ───────── Expenses ───────── */

export async function getExpenseCategoriesAPI(params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/expenses/categories${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

export async function createExpenseCategoryAPI(data, accessToken) {
  return request("/api/expenses/categories", { method: "POST", body: JSON.stringify(data), token: accessToken });
}

export async function updateExpenseCategoryAPI(id, data, accessToken) {
  return request(`/api/expenses/categories/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}

export async function deleteExpenseCategoryAPI(id, accessToken) {
  return request(`/api/expenses/categories/${id}`, { method: "DELETE", token: accessToken });
}

export async function getProjectExpenseSummaryAPI(projectId, accessToken) {
  return request(`/api/expenses/project/${projectId}/summary`, { method: "GET", token: accessToken });
}

export async function getExpenseStatsAPI(accessToken) {
  return request("/api/expenses/stats", { method: "GET", token: accessToken });
}

export async function getExpensesAPI(params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/expenses${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

export async function getMyExpensesAPI(params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/expenses/my${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

export async function getExpenseAPI(id, accessToken) {
  return request(`/api/expenses/${id}`, { method: "GET", token: accessToken });
}

export async function createExpenseAPI(data, accessToken) {
  return request("/api/expenses", { method: "POST", body: JSON.stringify(data), token: accessToken });
}

export async function updateExpenseAPI(id, data, accessToken) {
  return request(`/api/expenses/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}

export async function deleteExpenseAPI(id, accessToken) {
  return request(`/api/expenses/${id}`, { method: "DELETE", token: accessToken });
}

export async function approveExpenseAPI(id, data, accessToken) {
  return request(`/api/expenses/${id}/approve`, { method: "POST", body: JSON.stringify(data), token: accessToken });
}

export async function rejectExpenseAPI(id, data, accessToken) {
  return request(`/api/expenses/${id}/reject`, { method: "POST", body: JSON.stringify(data), token: accessToken });
}

export async function payExpenseAPI(id, data, accessToken) {
  return request(`/api/expenses/${id}/pay`, { method: "POST", body: JSON.stringify(data), token: accessToken });
}

export async function cancelExpenseAPI(id, accessToken) {
  return request(`/api/expenses/${id}/cancel`, { method: "POST", body: JSON.stringify({}), token: accessToken });
}

/* ───────── Campaigns ───────── */

export async function getCampaignTypesAPI(params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/campaigns/types${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

export async function createCampaignTypeAPI(data, accessToken) {
  return request("/api/campaigns/types", { method: "POST", body: JSON.stringify(data), token: accessToken });
}

export async function updateCampaignTypeAPI(id, data, accessToken) {
  return request(`/api/campaigns/types/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}

export async function deleteCampaignTypeAPI(id, accessToken) {
  return request(`/api/campaigns/types/${id}`, { method: "DELETE", token: accessToken });
}

export async function getCampaignsAPI(params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/campaigns${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

export async function getCampaignAPI(id, accessToken) {
  return request(`/api/campaigns/${id}`, { method: "GET", token: accessToken });
}

export async function createCampaignAPI(data, accessToken) {
  return request("/api/campaigns", { method: "POST", body: JSON.stringify(data), token: accessToken });
}

export async function updateCampaignAPI(id, data, accessToken) {
  return request(`/api/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}

export async function deleteCampaignAPI(id, accessToken) {
  return request(`/api/campaigns/${id}`, { method: "DELETE", token: accessToken });
}

export async function getCampaignStatsAPI(id, params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/campaigns/${id}/stats${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

export async function upsertCampaignStatAPI(id, data, accessToken) {
  return request(`/api/campaigns/${id}/stats`, { method: "POST", body: JSON.stringify(data), token: accessToken });
}

export async function deleteCampaignStatAPI(id, date, accessToken) {
  return request(`/api/campaigns/${id}/stats/${date}`, { method: "DELETE", token: accessToken });
}

export async function getProjectAdBudgetAPI(projectId, params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/campaigns/budget/project/${projectId}${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

/* ───────── Ad Budget ───────── */

export async function getAdBudgetOverviewAPI(params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/campaigns/budget/overview${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

export async function getAdBudgetLedgerAPI(projectId, params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/campaigns/budget/project/${projectId}/ledger${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

export async function addAdBudgetEntryAPI(projectId, data, accessToken) {
  return request(`/api/campaigns/budget/project/${projectId}/entries`, {
    method: "POST", body: JSON.stringify(data), token: accessToken,
  });
}

export async function deleteAdBudgetEntryAPI(entryId, accessToken) {
  return request(`/api/campaigns/budget/entries/${entryId}`, { method: "DELETE", token: accessToken });
}

export async function getCampaignAnalyticsAPI(params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/campaigns/analytics${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

export async function getProjectCampaignAnalyticsAPI(projectId, params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/campaigns/analytics/project/${projectId}${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

/* ───────── Payment Accounts ───────── */

export async function getPaymentAccountsAPI(params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/payment-accounts${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

export async function createPaymentAccountAPI(data, accessToken) {
  return request("/api/payment-accounts", { method: "POST", body: JSON.stringify(data), token: accessToken });
}

export async function updatePaymentAccountAPI(id, data, accessToken) {
  return request(`/api/payment-accounts/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}

export async function deletePaymentAccountAPI(id, accessToken) {
  return request(`/api/payment-accounts/${id}`, { method: "DELETE", token: accessToken });
}

export async function addInvoicePaymentAPI(id, data, accessToken) {
  return request(`/api/invoices/${id}/payments`, { method: "POST", body: JSON.stringify(data), token: accessToken });
}

export async function deleteInvoicePaymentAPI(id, paymentId, accessToken) {
  return request(`/api/invoices/${id}/payments/${paymentId}`, { method: "DELETE", token: accessToken });
}

/* ───────── Project Reports ───────── */

export async function previewReportAPI(params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/reports/preview?${qs}`, { method: "GET", token: accessToken });
}

export async function listReportsAPI(params, accessToken) {
  const qs = new URLSearchParams(params || {}).toString();
  return request(`/api/reports${qs ? `?${qs}` : ""}`, { method: "GET", token: accessToken });
}

export async function generateReportAPI(data, accessToken) {
  return request("/api/reports", { method: "POST", body: JSON.stringify(data), token: accessToken });
}

export async function getReportAPI(id, accessToken) {
  return request(`/api/reports/${id}`, { method: "GET", token: accessToken });
}

export async function updateReportAPI(id, data, accessToken) {
  return request(`/api/reports/${id}`, { method: "PATCH", body: JSON.stringify(data), token: accessToken });
}

export async function clearReportOverrideAPI(id, path, accessToken) {
  return request(`/api/reports/${id}/clear-override`, {
    method: "POST", body: JSON.stringify({ path }), token: accessToken,
  });
}

export async function deleteReportAPI(id, accessToken) {
  return request(`/api/reports/${id}`, { method: "DELETE", token: accessToken });
}

/* ───────── AI ───────── */

export async function listAiModelsAPI(data, accessToken) {
  return request("/api/ai/models", {
    method: "POST", body: JSON.stringify(data || {}), token: accessToken,
  });
}

export async function sendInvoiceEmailAPI(id, data, accessToken) {
  return request(`/api/invoices/${id}/send`, {
    method: "POST", body: JSON.stringify(data || {}), token: accessToken,
  });
}

/* ───────── Project Cycles ───────── */

export async function getProjectCyclesAPI(projectId, accessToken) {
  return request(`/api/project-cycles/project/${projectId}`, { method: "GET", token: accessToken });
}

export async function getCurrentCycleAPI(projectId, accessToken) {
  return request(`/api/project-cycles/project/${projectId}/current`, { method: "GET", token: accessToken });
}

export async function startNextCycleAPI(projectId, data, accessToken) {
  return request(`/api/project-cycles/project/${projectId}/next`, {
    method: "POST", body: JSON.stringify(data || {}), token: accessToken,
  });
}

export async function getCarryOverCandidatesAPI(cycleId, accessToken) {
  return request(`/api/project-cycles/${cycleId}/carry-over`, { method: "GET", token: accessToken });
}
