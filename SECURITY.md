# Security policy

OpenDelegate is pre-release software and has no supported release line yet.

There is not yet a configured private vulnerability-reporting route. Before this repository opens
publicly, the Owner must enable GitHub Private Vulnerability Reporting and update this file with the
exact verified route. Do not assume that a general issue or discussion is private.

Never post vulnerability details, exploit steps, credentials, Secret values, enrollment grants,
recovery data, private Task content, native Agent Session data, or Device Knowledge in a public
issue. Device Knowledge includes filenames, titles, links, index data, snippets, and content.

Until a private route exists, a reporter may use the **Private security channel request** issue
form. It states only that a private channel is needed and intentionally has no diagnostic or
reproduction fields. Do not add technical details, affected identifiers, diagnostics, screenshots,
or reproduction steps to that issue. The maintainer must establish a private path before requesting
or receiving the report.

Security-sensitive boundaries include Device enrollment, owner authentication, Policy enforcement,
Worker transport identity, Secret handling, generated Artifact isolation, native Agent Sessions,
desktop control, and the rule that Worker Knowledge never leaves its Device.
