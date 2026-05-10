/**
 * Memory Engine Client for TinyWins Multi-Agent System
 * Provides tenant-aware access to Memory Engine OAuth and Google Workspace actions
 *
 * IMPORTANT: This client is tenant-aware and REQUIRES a tenant ID for all operations.
 * All functions accept a tenantId parameter. If not provided, it will attempt to
 * read from TENANT_ID environment variable. If neither is available, an error is thrown
 * to prevent accidental cross-tenant access.
 */

const { retry: withRetry } = require('./resilience');

const MEMORY_ENGINE_URL = process.env.MEMORY_ENGINE_URL || 'https://memory-engine-230664305014.us-central1.run.app';

/**
 * Get tenant ID from context
 * Priority: 1) Explicit parameter, 2) Environment variable
 * Throws if neither is available to prevent accidental cross-tenant access
 */
function getTenantId(tenantId) {
    const resolvedId = tenantId || process.env.TENANT_ID;
    if (!resolvedId) {
        throw new Error('Tenant ID is required but not provided. Pass tenantId parameter or set TENANT_ID environment variable.');
    }
    return resolvedId;
}

/**
 * Call Memory Engine API with tenant context
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {object} body - Request body
 * @param {string} tenantId - Tenant ID (optional, will use context if not provided)
 */
async function callMemoryEngine(method, path, body = null, tenantId = null) {
    const url = `${MEMORY_ENGINE_URL}${path}`;
    const resolvedTenantId = getTenantId(tenantId);

    const headers = {
        'Content-Type': 'application/json',
        'x-tenant-id': resolvedTenantId
    };

    const options = {
        method,
        headers
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    let response;
    try {
        response = await withRetry(
            () => fetch(url, options),
            { op: 'callMemoryEngine', maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 }
        );
    } catch (err) {
        console.error(`[memory-engine-client] All retry attempts failed for ${method} ${path}: ${err.message}`);
        throw err;
    }

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Memory Engine API error: ${response.status} ${error}`);
    }

    return await response.json();
}

/**
 * OAuth Actions
 */
async function connectGoogle(tenantId = null) {
    const result = await callMemoryEngine('POST', '/oauth/authorize', {
        provider: 'google',
        scopes: [
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/calendar.readonly',
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/drive',
            'https://www.googleapis.com/auth/documents'
        ],
        redirect_uri: `${MEMORY_ENGINE_URL}/oauth/callback`
    }, tenantId);

    return {
        authUrl: result.authorization_url,
        expiresAt: result.expires_at
    };
}

async function checkGoogleStatus(tenantId = null) {
    const result = await callMemoryEngine('GET', '/oauth/status', null, tenantId);
    const googleProvider = result.linked_providers?.find(p => p.provider === 'google');

    return {
        connected: !!googleProvider,
        email: googleProvider?.provider_user_id,
        scopes: googleProvider?.scopes || [],
        expiresAt: googleProvider?.expires_at
    };
}


async function connectNotion(tenantId = null) {
    const result = await callMemoryEngine('POST', '/oauth/authorize', {
        provider: 'notion',
        scopes: [],
        redirect_uri: `${MEMORY_ENGINE_URL}/oauth/callback`
    }, tenantId);

    return {
        authUrl: result.authorization_url,
        expiresAt: result.expires_at
    };
}

async function checkNotionStatus(tenantId = null) {
    const result = await callMemoryEngine('GET', '/oauth/status', null, tenantId);
    const notionProvider = result.linked_providers?.find(p => p.provider === 'notion');

    return {
        connected: !!notionProvider,
        userId: notionProvider?.provider_user_id,
        scopes: notionProvider?.scopes || [],
        expiresAt: notionProvider?.expires_at
    };
}
/**
 * Gmail Actions
 */
async function searchGmail(query, maxResults = 10, tenantId = null) {
    return await callMemoryEngine('POST', '/actions/google/gmail/search', {
        query,
        max_results: maxResults,
        include_body: true
    }, tenantId);
}

async function listGmail(maxResults = 10, labelIds = null, tenantId = null) {
    const body = {
        max_results: maxResults,
        include_body: true
    };
    if (labelIds) {
        body.label_ids = labelIds;
    }
    return await callMemoryEngine('POST', '/actions/google/gmail/list', body, tenantId);
}

async function sendGmail(to, subject, body, cc = null, bcc = null, tenantId = null) {
    const payload = { to, subject, body };
    if (cc) payload.cc = cc;
    if (bcc) payload.bcc = bcc;
    return await callMemoryEngine('POST', '/actions/google/gmail/send', payload, tenantId);
}

/**
 * Calendar Actions
 */
async function listCalendarEvents(daysAhead = 7, maxResults = 10, tenantId = null) {
    const now = new Date();
    const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    return await callMemoryEngine('POST', '/actions/google/calendar/list', {
        time_min: now.toISOString(),
        time_max: future.toISOString(),
        max_results: maxResults,
        single_events: true,
        order_by: 'startTime'
    }, tenantId);
}

async function createCalendarEvent(summary, start, end, description = null, attendees = null, tenantId = null) {
    const body = { summary, start, end };
    if (description) body.description = description;
    if (attendees) body.attendees = attendees;
    return await callMemoryEngine('POST', '/actions/google/calendar/create', body, tenantId);
}

async function respondCalendarEvent(eventId, response, tenantId = null) {
    return await callMemoryEngine('POST', '/actions/google/calendar/respond', {
        event_id: eventId,
        response
    }, tenantId);
}

/**
 * Drive Actions
 */
async function searchDrive(query, maxResults = 10, tenantId = null) {
    return await callMemoryEngine('POST', '/actions/google/drive/search', {
        query,
        max_results: maxResults,
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)'
    }, tenantId);
}

async function listDrive(maxResults = 10, orderBy = 'modifiedTime desc', tenantId = null) {
    return await callMemoryEngine('POST', '/actions/google/drive/list', {
        max_results: maxResults,
        order_by: orderBy,
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)'
    }, tenantId);
}


/**
 * Experience Library Actions
 */
async function getLessons(taskContext, tenantId = null) {
    try {
        // In a full implementation, this would call a Memory Engine vector search endpoint.
        // For now, we simulate extraction from local MISTAKES.md based on keywords.
        const fs = require('fs');
        const path = require('path');
        const mistakesPath = path.join('/opt/openclaw/clawd', 'MISTAKES.md');
        
        let lessonsApplied = [
            "Always check for null before accessing user.id (Memory ID: M-104)",
            "Do not assume the config file exists in the root directory (Memory ID: M-112)"
        ];
        
        if (fs.existsSync(mistakesPath)) {
            const content = fs.readFileSync(mistakesPath, 'utf8');
            const lines = content.split('\n').filter(l => l.trim().startsWith('-'));
            if (lines.length > 0) {
                // simple keyword matching simulation
                lessonsApplied = lines.slice(0, 3).map(l => l.replace(/^- /, '').trim() + ' (Memory ID: Local)');
            }
        }
        
        const result = {
            taskId: "task-" + Date.now(),
            lessonsApplied
        };
        
        if (!result.lessonsApplied || result.lessonsApplied.length === 0) {
            return "";
        }
        
        let formatted = "\n\n## Past Lessons to Apply\n";
        result.lessonsApplied.forEach(lesson => {
            formatted += `- ${lesson}\n`;
        });
        
        return formatted;
    } catch (e) {
        console.error("Failed to retrieve lessons:", e.message);
        return "";
    }
}

module.exports = {
    // OAuth
    connectGoogle,
    checkGoogleStatus,

    connectNotion,
    checkNotionStatus,

    // Gmail
    searchGmail,
    listGmail,
    sendGmail,

    // Calendar
    listCalendarEvents,
    createCalendarEvent,
    respondCalendarEvent,

    // Drive
    searchDrive,
    listDrive,

    getLessons,

    // Raw API access
    callMemoryEngine,

    // Utilities
    getTenantId,

    // Constants
    MEMORY_ENGINE_URL
};
