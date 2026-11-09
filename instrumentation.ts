export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { validateConfiguration } = await import("./lib/config");
    try {
      validateConfiguration();
    } catch {
      throw new Error(
        "Invalid ChurchPay configuration. See .env.example and README.md.",
      );
    }
  }
}
