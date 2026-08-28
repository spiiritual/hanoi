// oxlint-disable-next-line sonarjs/bool-param-default -- omitted means server status is still being checked
export const serverStatusLabel = (online?: boolean): string => {
  if (online === true) {
    return "● Online";
  }
  if (online === false) {
    return "○ Offline";
  }
  return "Checking…";
};

// oxlint-disable-next-line sonarjs/bool-param-default -- omitted means server status is still being checked
export const serverStatusClass = (online?: boolean): string => {
  if (online === true) {
    return "is-online";
  }
  if (online === false) {
    return "is-offline";
  }
  return "is-checking";
};
