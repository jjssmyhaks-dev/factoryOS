# @factory/ingress

Thin webhook ingress Lambdas (PRD §4.2 stack row, §4.3 rule 1): **verify signature → persist raw event → enqueue → 2xx in under 2 seconds.** All processing is asynchronous (Appendix B: webhooks verify signatures and reject replays).

`src/webhook.ts` is the channel-agnostic core (`handleWebhook`) with an HMAC verifier; WhatsApp (E5-S1: media download by media ID, dedupe), email (E5-S5: SPF/DKIM recorded) and IndiaMART wrap it with their channel secrets. The raw event is persisted *before* enqueue so a lost message can be replayed.
