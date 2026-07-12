"""One-shot request handler used by the live MCP debugger E2E test."""


request = {
    "method": "GET",
    "path": "/mcp-e2e/",
    "user": "fixture-user",
}
response = {
    "status": 200,
    "marker": "mcp-live-e2e",
}
completed_marker = response["marker"]  # MCP_E2E_BREAKPOINT
