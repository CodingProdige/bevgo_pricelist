export function buildUiMessage({ type = "info", title = "", message = "", detail = null } = {}) {
  return {
    type,
    title,
    message,
    detail
  };
}
