const { AsyncLocalStorage } = require("async_hooks");

const requestContext = new AsyncLocalStorage();

/**
 * Extracts the base URL (protocol + host) from an incoming Express / HTTP request object.
 * Supports standard headers and reverse proxy headers (X-Forwarded-Proto, X-Forwarded-Host).
 */
function extractBaseUrlFromReq(req) {
    if (!req) return null;

    let proto = "http";
    const forwardedProto = req.headers && (req.headers["x-forwarded-proto"] || req.headers["x-forwarded-protocol"]);
    if (forwardedProto) {
        proto = String(forwardedProto).split(",")[0].trim().toLowerCase();
    } else if (req.headers && req.headers["x-forwarded-ssl"] === "on") {
        proto = "https";
    } else if (req.protocol) {
        proto = String(req.protocol).toLowerCase();
    }

    let host = null;
    const forwardedHost = req.headers && req.headers["x-forwarded-host"];
    if (forwardedHost) {
        host = String(forwardedHost).split(",")[0].trim();
    } else if (req.headers && req.headers.host) {
        host = String(req.headers.host).trim();
    }

    if (!host) return null;
    return `${proto}://${host}`.replace(/\/+$/, "");
}

/**
 * Returns the effective base URL for generating streams, redirects, and manifest links.
 * Priority:
 * 1. Explicit non-localhost BASE_URL from process.env (operator override)
 * 2. Dynamic baseUrl from current request context (via AsyncLocalStorage)
 * 3. process.env.BASE_URL if set (even if localhost)
 * 4. Default: "http://127.0.0.1:7002"
 */
function getRequestBaseUrl() {
    const envBase = (process.env.BASE_URL || "").trim().replace(/\/+$/, "");
    const isExplicitRemote = envBase && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(envBase);

    if (isExplicitRemote) {
        return envBase;
    }

    const store = requestContext.getStore();
    if (store && store.baseUrl) {
        return store.baseUrl;
    }

    if (envBase) {
        return envBase;
    }

    return "http://127.0.0.1:7002";
}

function runWithRequestContext(context, fn) {
    return requestContext.run(context, fn);
}

module.exports = {
    requestContext,
    extractBaseUrlFromReq,
    getRequestBaseUrl,
    runWithRequestContext
};
