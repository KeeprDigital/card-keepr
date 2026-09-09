# Errata owner request pacing

The full hosted #271 run at `9e22a3409808b11d863072f9358916c0f22879a1`
failed the Errata acceptance journey with HTTP 429 while inspecting the omission
candidate. The fixture allows 300 administration requests per minute; native
preparation and owner CLI operations previously used separate, unpaced paths.

Implementation `7a530532d81e95c9ede96823f5d263657a72af1f` uses the existing
native request interval and one 250 ms administration queue across CLI requests,
native helpers, and direct fixture administration. Consumer reads, the 300/minute
guard, production behavior, test assertions, retries and deadlines are unchanged.

Independent Standards (toolchain agent) and Spec (source agent) reviews against
the fixed parent found no actionable issues.

The complete acceptance file at that exact commit passed **3/3**, naturally:
97.633 seconds harness, 97.567 seconds Node, 84.837 seconds main journey. It ran
exclusively on this host with Node 22.23.2. The outer 600-second bound includes
the previously measured 64-second hosted journey and the newly shared queue;
it did not interrupt the run. Syntax and formatting checks passed.

Raw evidence is retained at
`/tmp/card-keepr-launch-20260909/errata-pacing-full-7a530532.log` and
`/tmp/card-keepr-launch-20260909/errata-pacing-full-7a530532.json`.

This is focused local acceptance evidence. Integration CI and #271's complete
validation gate remain open; it does not close #253's stress or scheduled proof.
