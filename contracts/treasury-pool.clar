;; contracts/treasury-pool.clar
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-PROPOSAL-NOT-FOUND u101)
(define-constant ERR-INSUFFICIENT-FUNDS u102)
(define-constant ERR-ALREADY-RELEASED u103)
(define-constant ERR-INVALID-AMOUNT u104)
(define-constant ERR-PROPOSAL-NOT-PASSED u105)
(define-constant ERR-EXECUTION-FAILED u106)

(define-data-var total-reserved uint u0)
(define-data-var total-released uint u0)

(define-map proposal-funding uint {
    amount: uint,
    recipient: principal,
    released: bool,
    proposal-id: uint
})

(define-map donations principal uint)

(define-read-only (get-proposal-funding (proposal-id uint))
    (map-get? proposal-funding proposal-id)
)

(define-read-only (get-total-reserved)
    (var-get total-reserved)
)

(define-read-only (get-total-released)
    (var-get total-released)
)

(define-read-only (get-donor-balance (donor principal))
    (default-to u0 (map-get? donations donor))
)

(define-read-only (get-treasury-balance)
    (stx-get-balance (as-contract tx-sender))
)

(define-public (donate (amount uint))
    (let ((donor tx-sender))
        (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
        (try! (stx-transfer? amount donor (as-contract tx-sender)))
        (map-set donations donor
            (+ (get-donor-balance donor) amount))
        (print { event: "donation-received", donor: donor, amount: amount })
        (ok true)
    )
)

(define-public (reserve-funds (proposal-id uint) (amount uint) (recipient principal))
    (let (
        (current-reserved (var-get total-reserved))
        (treasury-balance (get-treasury-balance))
    )
        (asserts! (is-eq tx-sender (contract-call? .dao-governance get-authority)) (err ERR-UNAUTHORIZED))
        (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
        (asserts! (>= treasury-balance (+ current-reserved amount)) (err ERR-INSUFFICIENT-FUNDS))
        (asserts! (is-none (map-get? proposal-funding proposal-id)) (err ERR-PROPOSAL-NOT-FOUND))
        (map-set proposal-funding proposal-id {
            amount: amount,
            recipient: recipient,
            released: false,
            proposal-id: proposal-id
        })
        (var-set total-reserved (+ current-reserved amount))
        (print { event: "funds-reserved", proposal-id: proposal-id, amount: amount })
        (ok true)
    )
)

(define-public (release-funds (proposal-id uint))
    (let (
        (funding (unwrap! (map-get? proposal-funding proposal-id) (err ERR-PROPOSAL-NOT-FOUND)))
        (amount (get amount funding))
        (recipient (get recipient funding))
    )
        (asserts! (is-eq tx-sender (as-contract .dao-governance)) (err ERR-UNAUTHORIZED))
        (asserts! (not (get released funding)) (err ERR-ALREADY-RELEASED))
        (asserts! (contract-call? .dao-governance is-proposal-passed proposal-id) (err ERR-PROPOSAL-NOT-PASSED))
        (try! (as-contract (stx-transfer? amount tx-sender recipient)))
        (map-set proposal-funding proposal-id
            (merge funding { released: true }))
        (var-set total-reserved (- (var-get total-reserved) amount))
        (var-set total-released (+ (var-get total-released) amount))
        (print { event: "funds-released", proposal-id: proposal-id, recipient: recipient, amount: amount })
        (ok true)
    )
)

(define-public (emergency-withdraw (amount uint) (to principal))
    (begin
        (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
        (asserts! (<= amount (get-treasury-balance)) (err ERR-INSUFFICIENT-FUNDS))
        (try! (as-contract (stx-transfer? amount tx-sender to)))
        (ok true)
    )
)

(define-data-var admin principal tx-sender)