// Its own module so smtp.js and transport.js can both use it without importing
// each other — the cycle that would otherwise force a lazy/global workaround.
export class MailNotConfigured extends Error {
  constructor(detail) {
    super("Email is not configured, so nothing can be sent yet.");
    this.name = "MailNotConfigured";
    this.code = "mail_not_configured";
    this.detail = detail;
  }
}
