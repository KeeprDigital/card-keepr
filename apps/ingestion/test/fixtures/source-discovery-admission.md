# Retained discovery admission fixture

`source-discovery-admission.json` retains five exact Scryfall normal-image
proposals and their independently recorded request identities/fingerprints from
[#327's retained archive evidence](https://github.com/KeeprDigital/card-keepr/issues/327#issuecomment-5665607145).
The listing was `default-cards-20260914090527.jsonl.gz`, declared compressed
length 78,247,919 bytes. The small native retained-byte replay verified these
identities before the two-population admission diagnostic used them.

The tests perform no Source/image GET. They exercise production request admission
with these literal proposals and deterministic synthetic padding. Population
8,192 is the prefix of population17,408; the manifest pins each padding chain and
the canonical proposal digest. The normal test deliberately seeds a mismatching
URL under one of the known identities to check atomic collision rejection.

The explicit stress test's native batch-result row budget permits retained
capacity counting while detecting repeated scans of unrelated retained plans.
It does not establish complete archive throughput, equality or image capacity.
