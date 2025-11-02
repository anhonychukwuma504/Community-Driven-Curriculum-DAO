(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-PROPOSAL-NOT-FOUND u101)
(define-constant ERR-INVALID-STATE u102)
(define-constant ERR-VOTING-CLOSED u103)
(define-constant ERR-ALREADY-VOTED u104)
(define-constant ERR-INSUFFICIENT-STAKE u105)
(define-constant ERR-EXECUTION-FAILED u106)
(define-constant ERR-INVALID-THRESHOLD u107)
(define-constant ERR-PROPOSAL-EXISTS u108)

(define-constant PROPOSAL-STATE-DRAFT u0)
(define-constant PROPOSAL-STATE-VOTING u1)
(define-constant PROPOSAL-STATE-PASSED u2)
(define-constant PROPOSAL-STATE-REJECTED u3)
(define-constant PROPOSAL-STATE-EXECUTING u4)
(define-constant PROPOSAL-STATE-COMPLETED u5)

(define-data-var next-proposal-id uint u0)
(define-data-var min-stake-to-propose uint u1000000)
(define-data-var voting-duration uint u144)
(define-data-var execution-delay uint u10)
(define-data-var passing-threshold uint u51)

(define-map proposals uint {
    id: uint,
    title: (string-utf8 128),
    description: (string-utf8 1024),
    proposer: principal,
    stake: uint,
    start-block: uint,
    end-block: uint,
    state: uint,
    yes-votes: uint,
    no-votes: uint,
    executed: bool
})

(define-map votes { proposal-id: uint, voter: principal } {
    support: bool,
    weight: uint
})

(define-map proposal-hashes uint (buff 32))

(define-read-only (get-proposal (id uint))
    (map-get? proposals id)
)

(define-read-only (get-vote (proposal-id uint) (voter principal))
    (map-get? votes { proposal-id: proposal-id, voter: voter })
)

(define-read-only (get-next-id)
    (var-get next-proposal-id)
)

(define-read-only (is-voting-active (id uint))
    (match (map-get? proposals id)
        p (and 
            (is-eq (get state p) PROPOSAL-STATE-VOTING)
            (>= block-height (get start-block p))
            (<= block-height (get end-block p))
          )
        false
    )
)

(define-public (submit-proposal 
    (title (string-utf8 128)) 
    (description (string-utf8 1024)) 
    (content-hash (buff 32))
    (stake-amount uint)
)
    (let (
        (proposal-id (var-get next-proposal-id))
        (sender tx-sender)
        (current-block block-height)
    )
        (asserts! (>= stake-amount (var-get min-stake-to-propose)) (err ERR-INSUFFICIENT-STAKE))
        (asserts! (is-none (map-get? proposal-hashes proposal-id)) (err ERR-PROPOSAL-EXISTS))
        (try! (stx-transfer? stake-amount sender (as-contract tx-sender)))
        (map-set proposals proposal-id {
            id: proposal-id,
            title: title,
            description: description,
            proposer: sender,
            stake: stake-amount,
            start-block: (+ current-block u1),
            end-block: (+ current-block u1 (var-get voting-duration)),
            state: PROPOSAL-STATE-DRAFT,
            yes-votes: u0,
            no-votes: u0,
            executed: false
        })
        (map-set proposal-hashes proposal-id content-hash)
        (var-set next-proposal-id (+ proposal-id u1))
        (print { event: "proposal-submitted", id: proposal-id, proposer: sender })
        (ok proposal-id)
    )
)

(define-public (start-voting (proposal-id uint))
    (let ((proposal (unwrap! (map-get? proposals proposal-id) (err ERR-PROPOSAL-NOT-FOUND))))
        (asserts! (is-eq (get proposer proposal) tx-sender) (err ERR-UNAUTHORIZED))
        (asserts! (is-eq (get state proposal) PROPOSAL-STATE-DRAFT) (err ERR-INVALID-STATE))
        (asserts! (>= block-height (get start-block proposal)) (err ERR-INVALID-STATE))
        (map-set proposals proposal-id
            (merge proposal { state: PROPOSAL-STATE-VOTING, start-block: block-height }))
        (ok true)
    )
)

(define-public (cast-vote (proposal-id uint) (support bool) (weight uint))
    (let (
        (proposal (unwrap! (map-get? proposals proposal-id) (err ERR-PROPOSAL-NOT-FOUND)))
        (voter tx-sender)
        (existing-vote (map-get? votes { proposal-id: proposal-id, voter: voter }))
    )
        (asserts! (is-voting-active proposal-id) (err ERR-VOTING-CLOSED))
        (asserts! (is-none existing-vote) (err ERR-ALREADY-VOTED))
        (asserts! (> weight u0) (err ERR-INSUFFICIENT-STAKE))
        (map-set votes { proposal-id: proposal-id, voter: voter } {
            support: support,
            weight: weight
        })
        (map-set proposals proposal-id
            (merge proposal {
                yes-votes: (if support (+ (get yes-votes proposal) weight) (get yes-votes proposal)),
                no-votes: (if support (get no-votes proposal) (+ (get no-votes proposal) weight))
            })
        )
        (ok true)
    )
)

(define-public (end-voting (proposal-id uint))
    (let (
        (proposal (unwrap! (map-get? proposals proposal-id) (err ERR-PROPOSAL-NOT-FOUND)))
        (total-votes (+ (get yes-votes proposal) (get no-votes proposal)))
        (yes-percent (if (> total-votes u0) (/ (* (get yes-votes proposal) u100) total-votes) u0))
    )
        (asserts! (>= block-height (get end-block proposal)) (err ERR-VOTING-CLOSED))
        (asserts! (is-eq (get state proposal) PROPOSAL-STATE-VOTING) (err ERR-INVALID-STATE))
        (map-set proposals proposal-id
            (merge proposal {
                state: (if (>= yes-percent (var-get passing-threshold))
                    PROPOSAL-STATE-PASSED
                    PROPOSAL-STATE-REJECTED
                )
            })
        )
        (ok true)
    )
)

(define-public (execute-proposal (proposal-id uint))
    (let ((proposal (unwrap! (map-get? proposals proposal-id) (err ERR-PROPOSAL-NOT-FOUND))))
        (asserts! (is-eq (get state proposal) PROPOSAL-STATE-PASSED) (err ERR-INVALID-STATE))
        (asserts! (not (get executed proposal)) (err ERR-EXECUTION-FAILED))
        (asserts! (>= block-height (+ (get end-block proposal) (var-get execution-delay))) (err ERR-INVALID-STATE))
        (map-set proposals proposal-id
            (merge proposal { state: PROPOSAL-STATE-EXECUTING }))
        (as-contract (try! (contract-call? .treasury-pool release-funds proposal-id)))
        (as-contract (try! (contract-call? .content-registry register-curriculum proposal-id)))
        (try! (contract-call? .contributor-rewards distribute proposal-id))
        (map-set proposals proposal-id
            (merge proposal { state: PROPOSAL-STATE-COMPLETED, executed: true }))
        (print { event: "proposal-executed", id: proposal-id })
        (ok true)
    )
)

(define-public (update-threshold (new-threshold uint))
    (begin
        (asserts! (is-eq tx-sender (var-get authority-contract)) (err ERR-UNAUTHORIZED))
        (asserts! (and (>= new-threshold u1) (<= new-threshold u100)) (err ERR-INVALID-THRESHOLD))
        (var-set passing-threshold new-threshold)
        (ok true)
    )
)

(define-data-var authority-contract principal tx-sender)