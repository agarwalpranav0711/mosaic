# Reference Hashes Table (Engine Version 1)

Computed on hardware: **NVIDIA GeForce RTX 3050 Laptop GPU** (Google Chrome 155, Windows 11, Direct3D12 backend via ANGLE).

Use this reference table to verify deterministic cross-device execution on phones and other GPUs.

| Name | Planet ID | Rehash Counter | Palette Index | Palette Name | Final 512 Keyframe Hash |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Priya** | `81357026` | 0 | 3 | Ice | `0x9a90facd` |
| **Rahul** | `184b2ca5` | 0 | 0 | Deep Sea | `0x1c470754` |
| **Aman** | `e57d2897` | 3 | 2 | Aurora | `0x7d0ece54` |
| **Neha** | `ed0aa39e` | 0 | 2 | Aurora | `0x48050231` |
| **Kuber** | `81e905b5` | 1 | 3 | Ice | `0x3fca3290` |

## Invariant Checklist

- Priya: Planet ID `81357026`, final keyframe `0x9a90facd`
- Rahul: Planet ID `184b2ca5`
- Aman: Planet ID `e57d2897` (rehash counter 3)
- Neha: Planet ID `ed0aa39e`
- Kuber: Planet ID `81e905b5` (rehash counter 1), final keyframe `0x3fca3290`
- Fixed tiles: B2 `0x985dade1`, C2 `0x329ac730`, D2 `0xa63eed4d`, Heavy `0x8a1e2fc9`
- regions.json SHA-256: `793adc48b7b93dc7226395233d2fc7a2140afa331cfcb07f705db9dec22d8238`
