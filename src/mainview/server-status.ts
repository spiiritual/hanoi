export function serverStatusLabel(online: boolean | undefined): string {
	return online === false ? "○ Offline" : "● Online";
}
