<!-- Provenance: old repo notes/draft_order.md (gitignored there, user-authored), copied verbatim 2026-11-06 at M0. -->


"classic":{
    "0bans": [
		{ team: "blue", action: "pick" },   1
		{ team: "red", action: "pick" },    2
		{ team: "red", action: "pick" },    3
		{ team: "blue", action: "pick" },   4
		{ team: "red", action: "pick" },    5
		{ team: "blue", action: "pick" },   6
		{ team: "blue", action: "pick" },   7
		{ team: "red", action: "pick" },    8
		{ team: "red", action: "pick" },    9
		{ team: "blue", action: "pick" },   10
		{ team: "blue", action: "pick" },   11
		{ team: "red", action: "pick" },    12
		{ team: "red", action: "pick" },    13
		{ team: "blue", action: "pick" },   14
		{ team: "blue", action: "pick" },   15
		{ team: "red", action: "pick" },    16     
    ]
    "4ban": [
		{ team: "blue", action: "ban" },    1
		{ team: "red", action: "ban" },     2
		{ team: "blue", action: "pick" },   3
		{ team: "red", action: "pick" },    4
		{ team: "red", action: "pick" },    5
		{ team: "blue", action: "pick" },   6
        { team: "red", action: "ban" },     7
		{ team: "blue", action: "ban" },    8
		{ team: "red", action: "pick" },    9
		{ team: "blue", action: "pick" },   10
		{ team: "blue", action: "pick" },   11
		{ team: "red", action: "pick" },    12
		{ team: "red", action: "pick" },    13
		{ team: "blue", action: "pick" },   14
		{ team: "blue", action: "pick" },   15
		{ team: "red", action: "pick" },    16
		{ team: "red", action: "pick" },    17
		{ team: "blue", action: "pick" },   18
		{ team: "blue", action: "pick" },   19
		{ team: "red", action: "pick" },    20
	],
	"6ban": [
		{ team: "blue", action: "ban" },    1
		{ team: "red", action: "ban" },     2
		{ team: "blue", action: "pick" },   3
		{ team: "red", action: "pick" },    4
		{ team: "red", action: "pick" },    5
		{ team: "blue", action: "pick" },   6
		{ team: "red", action: "ban" },     7
		{ team: "blue", action: "ban" },    8
		{ team: "red", action: "pick" },    9
		{ team: "blue", action: "pick" },   10
		{ team: "blue", action: "pick" },   11
		{ team: "red", action: "pick" },    12
		{ team: "blue", action: "ban" },    13
		{ team: "red", action: "ban" },     14
		{ team: "blue", action: "pick" },   15
        { team: "blue", action: "pick" },   16
		{ team: "red", action: "pick" },    17
		{ team: "red", action: "pick" },    18
		{ team: "blue", action: "pick" },   19
		{ team: "red", action: "pick" },    20
		{ team: "blue", action: "pick" },   21
        { team: "red", action: "pick" },    22
	],
}

"auction":{
    "4ban": [
		{ team: "blue", action: "ban" },        1
		{ team: "red", action: "ban" },         2
		{ team: "blue", action: "nominate" },   3
		{ team: "red", action: "nominate" },    4
		{ team: "blue", action: "nominate" },   5
		{ team: "red", action: "nominate" },    6
        { team: "red", action: "ban" },         7
		{ team: "blue", action: "ban" },        8
		{ team: "blue", action: "nominate" },   3
		{ team: "red", action: "nominate" },    4
		{ team: "blue", action: "nominate" },   5
		{ team: "red", action: "nominate" },    6
	],
	"6ban": [
		{ team: "blue", action: "ban" },    1
		{ team: "red", action: "ban" },     2
		{ team: "blue", action: "pick" },   3
		{ team: "red", action: "pick" },    4
		{ team: "red", action: "pick" },    5
		{ team: "blue", action: "pick" },   6
		{ team: "red", action: "ban" },     7
		{ team: "blue", action: "ban" },    8
		{ team: "red", action: "pick" },    9
		{ team: "blue", action: "pick" },   10
		{ team: "blue", action: "pick" },   11
		{ team: "red", action: "pick" },    12
		{ team: "blue", action: "ban" },    13
		{ team: "red", action: "ban" },     14
		{ team: "blue", action: "pick" },   15
        { team: "blue", action: "pick" },   16
		{ team: "red", action: "pick" },    17
		{ team: "red", action: "pick" },    18
		{ team: "blue", action: "pick" },   19
		{ team: "red", action: "pick" },    20
		{ team: "blue", action: "pick" },   21
        { team: "red", action: "pick" },    22
	],
}


## Thirds (12 picks per team) — DECISIONS.md A59, Phase S7b execution

Classic draft orders for `lineupFormat = Thirds`, one per ban mode (implemented in `spacetimedb/src/helpers/draft/draftSequences.ts`, `THIRDS_ORDERS`). Notation: B / R = a Blue / Red pick, bans in brackets, a `·` at every colour change.

Rules the three orders share:

- the first eight picks and every ban position are the Halves order of the same ban mode (ban pairs before the first pick, after four picks, and for Six after eight picks);
- 12 picks per team, Blue picks first and Red picks last;
- no run of the same colour longer than two;
- Thirds adds no bans.

Auction Thirds is unchanged: the sequence is the ban-only prefix of the ban mode, and the auction ends when both teams have won 12 characters (`isAuctionComplete` counts `charactersPerTeam(Thirds)` = 12).

- **None (24 steps): the Halves order, then `B R B R B B R R`**
  `B · RR · B · R · BB · RR · BB · RR · BB · R · B · R · B · R · BB · RR`
- **Four (28 steps): the Halves order, then two more `R B B R` rounds (the S7 order, unchanged)**
  `[B] · [R] · B · RR · B · [R] · [B] · R · BB · RR · BB · RR · BB · RR · BB · RR · BB · R`
- **Six (30 steps): the Halves order with two more `B B R R` rounds after the third ban pair, before the `B R B R` closer**
  `[B] · [R] · B · RR · B · [R] · [B] · R · BB · R · [B] · [R] · BB · RR · BB · RR · BB · RR · B · R · B · R`

As numbered step lists (same style as the 8-pick orders above):

```
"classic-thirds":{
    "0bans": [
		{ team: "blue", action: "pick" },   1
		{ team: "red", action: "pick" },    2
		{ team: "red", action: "pick" },    3
		{ team: "blue", action: "pick" },   4
		{ team: "red", action: "pick" },    5
		{ team: "blue", action: "pick" },   6
		{ team: "blue", action: "pick" },   7
		{ team: "red", action: "pick" },    8
		{ team: "red", action: "pick" },    9
		{ team: "blue", action: "pick" },   10
		{ team: "blue", action: "pick" },   11
		{ team: "red", action: "pick" },    12
		{ team: "red", action: "pick" },    13
		{ team: "blue", action: "pick" },   14
		{ team: "blue", action: "pick" },   15
		{ team: "red", action: "pick" },    16
		{ team: "blue", action: "pick" },   17
		{ team: "red", action: "pick" },    18
		{ team: "blue", action: "pick" },   19
		{ team: "red", action: "pick" },    20
		{ team: "blue", action: "pick" },   21
		{ team: "blue", action: "pick" },   22
		{ team: "red", action: "pick" },    23
		{ team: "red", action: "pick" },    24
	],
    "4ban": [
		{ team: "blue", action: "ban" },    1
		{ team: "red", action: "ban" },     2
		{ team: "blue", action: "pick" },   3
		{ team: "red", action: "pick" },    4
		{ team: "red", action: "pick" },    5
		{ team: "blue", action: "pick" },   6
		{ team: "red", action: "ban" },     7
		{ team: "blue", action: "ban" },    8
		{ team: "red", action: "pick" },    9
		{ team: "blue", action: "pick" },   10
		{ team: "blue", action: "pick" },   11
		{ team: "red", action: "pick" },    12
		{ team: "red", action: "pick" },    13
		{ team: "blue", action: "pick" },   14
		{ team: "blue", action: "pick" },   15
		{ team: "red", action: "pick" },    16
		{ team: "red", action: "pick" },    17
		{ team: "blue", action: "pick" },   18
		{ team: "blue", action: "pick" },   19
		{ team: "red", action: "pick" },    20
		{ team: "red", action: "pick" },    21
		{ team: "blue", action: "pick" },   22
		{ team: "blue", action: "pick" },   23
		{ team: "red", action: "pick" },    24
		{ team: "red", action: "pick" },    25
		{ team: "blue", action: "pick" },   26
		{ team: "blue", action: "pick" },   27
		{ team: "red", action: "pick" },    28
	],
    "6ban": [
		{ team: "blue", action: "ban" },    1
		{ team: "red", action: "ban" },     2
		{ team: "blue", action: "pick" },   3
		{ team: "red", action: "pick" },    4
		{ team: "red", action: "pick" },    5
		{ team: "blue", action: "pick" },   6
		{ team: "red", action: "ban" },     7
		{ team: "blue", action: "ban" },    8
		{ team: "red", action: "pick" },    9
		{ team: "blue", action: "pick" },   10
		{ team: "blue", action: "pick" },   11
		{ team: "red", action: "pick" },    12
		{ team: "blue", action: "ban" },    13
		{ team: "red", action: "ban" },     14
		{ team: "blue", action: "pick" },   15
		{ team: "blue", action: "pick" },   16
		{ team: "red", action: "pick" },    17
		{ team: "red", action: "pick" },    18
		{ team: "blue", action: "pick" },   19
		{ team: "blue", action: "pick" },   20
		{ team: "red", action: "pick" },    21
		{ team: "red", action: "pick" },    22
		{ team: "blue", action: "pick" },   23
		{ team: "blue", action: "pick" },   24
		{ team: "red", action: "pick" },    25
		{ team: "red", action: "pick" },    26
		{ team: "blue", action: "pick" },   27
		{ team: "red", action: "pick" },    28
		{ team: "blue", action: "pick" },   29
		{ team: "red", action: "pick" },    30
	],
}
```
