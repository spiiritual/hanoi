export function serverStatusLabel(online: boolean | undefined): string {
	if (online === true) return "● Online";
	if (online === false) return "○ Offline";
	return "Checking…";
}

export function serverStatusClass(online: boolean | undefined): string {
	if (online === true) return "is-online";
	if (online === false) return "is-offline";
	return "is-checking";
}
