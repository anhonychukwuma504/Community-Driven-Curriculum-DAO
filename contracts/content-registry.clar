;; contracts/content-registry.clar
(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-PROPOSAL-NOT-FOUND u101)
(define-constant ERR-ALREADY-REGISTERED u102)
(define-constant ERR-INVALID-METADATA u103)
(define-constant ERR-EXECUTION-FAILED u104)
(define-constant ERR-PROPOSAL-NOT-PASSED u105)

(define-constant MAX-TITLE-LENGTH u128)
(define-constant MAX-DESCRIPTION-LENGTH u1024)
(define-constant MAX-TAGS u10)

(define-data-var next-curriculum-id uint u0)

(define-map curricula uint {
    proposal-id: uint,
    curriculum-id: uint,
    title: (string-utf8 MAX-TITLE-LENGTH),
    description: (string-utf8 MAX-DESCRIPTION-LENGTH),
    content-hash: (buff 32),
    version: uint,
    authors: (list 20 principal),
    tags: (list MAX-TAGS (string-utf8 50)),
    registered-at: uint,
    updated-at: uint,
    is-active: bool
})

(define-map proposal-to-curriculum uint uint)

(define-read-only (get-curriculum (curriculum-id uint))
    (map-get? curricula curriculum-id)
)

(define-read-only (get-curriculum-by-proposal (proposal-id uint))
    (map-get? proposal-to-curriculum proposal-id)
)

(define-read-only (get-next-id)
    (var-get next-curriculum-id)
)

(define-read-only (validate-title (title (string-utf8 MAX-TITLE-LENGTH)))
    (> (len title) u0)
)

(define-read-only (validate-description (desc (string-utf8 MAX-DESCRIPTION-LENGTH)))
    (> (len desc) u0)
)

(define-read-only (validate-tags (tags (list MAX-TAGS (string-utf8 50))))
    (fold and (map (lambda (t) (> (len t) u0)) tags) true)
)

(define-public (register-curriculum 
    (proposal-id uint)
    (title (string-utf8 MAX-TITLE-LENGTH))
    (description (string-utf8 MAX-DESCRIPTION-LENGTH))
    (content-hash (buff 32))
    (authors (list 20 principal))
    (tags (list MAX-TAGS (string-utf8 50)))
)
    (let (
        (curriculum-id (var-get next-curriculum-id))
        (caller tx-sender)
        (current-block block-height)
    )
        (asserts! (is-eq caller (as-contract .dao-governance)) (err ERR-UNAUTHORIZED))
        (asserts! (is-none (map-get? proposal-to-curriculum proposal-id)) (err ERR-ALREADY-REGISTERED))
        (asserts! (contract-call? .dao-governance is-proposal-passed proposal-id) (err ERR-PROPOSAL-NOT-PASSED))
        (asserts! (validate-title title) (err ERR-INVALID-METADATA))
        (asserts! (validate-description description) (err ERR-INVALID-METADATA))
        (asserts! (validate-tags tags) (err ERR-INVALID-METADATA))
        (map-set curricula curriculum-id {
            proposal-id: proposal-id,
            curriculum-id: curriculum-id,
            title: title,
            description: description,
            content-hash: content-hash,
            version: u1,
            authors: authors,
            tags: tags,
            registered-at: current-block,
            updated-at: current-block,
            is-active: true
        })
        (map-set proposal-to-curriculum proposal-id curriculum-id)
        (var-set next-curriculum-id (+ curriculum-id u1))
        (print { 
            event: "curriculum-registered", 
            proposal-id: proposal-id, 
            curriculum-id: curriculum-id,
            title: title
        })
        (ok curriculum-id)
    )
)

(define-public (update-curriculum 
    (curriculum-id uint)
    (title (string-utf8 MAX-TITLE-LENGTH))
    (description (string-utf8 MAX-DESCRIPTION-LENGTH))
    (content-hash (buff 32))
    (tags (list MAX-TAGS (string-utf8 50)))
)
    (let (
        (curriculum (unwrap! (map-get? curricula curriculum-id) (err ERR-PROPOSAL-NOT-FOUND)))
        (current-block block-height)
    )
        (asserts! (is-eq tx-sender (as-contract .dao-governance)) (err ERR-UNAUTHORIZED))
        (asserts! (get is-active curriculum) (err ERR-PROPOSAL-NOT-FOUND))
        (asserts! (validate-title title) (err ERR-INVALID-METADATA))
        (asserts! (validate-description description) (err ERR-INVALID-METADATA))
        (asserts! (validate-tags tags) (err ERR-INVALID-METADATA))
        (map-set curricula curriculum-id
            (merge curriculum {
                title: title,
                description: description,
                content-hash: content-hash,
                tags: tags,
                version: (+ (get version curriculum) u1),
                updated-at: current-block
            })
        )
        (print { 
            event: "curriculum-updated", 
            curriculum-id: curriculum-id,
            version: (+ (get version curriculum) u1)
        })
        (ok true)
    )
)

(define-public (deactivate-curriculum (curriculum-id uint))
    (let ((curriculum (unwrap! (map-get? curricula curriculum-id) (err ERR-PROPOSAL-NOT-FOUND))))
        (asserts! (is-eq tx-sender (as-contract .dao-governance)) (err ERR-UNAUTHORIZED))
        (asserts! (get is-active curriculum) (err ERR-PROPOSAL-NOT-FOUND))
        (map-set curricula curriculum-id
            (merge curriculum { is-active: false }))
        (print { event: "curriculum-deactivated", curriculum-id: curriculum-id })
        (ok true)
    )
)

(define-public (reactivate-curriculum (curriculum-id uint))
    (let ((curriculum (unwrap! (map-get? curricula curriculum-id) (err ERR-PROPOSAL-NOT-FOUND))))
        (asserts! (is-eq tx-sender (as-contract .dao-governance)) (err ERR-UNAUTHORIZED))
        (asserts! (not (get is-active curriculum)) (err ERR-PROPOSAL-NOT-FOUND))
        (map-set curricula curriculum-id
            (merge curriculum { is-active: true }))
        (print { event: "curriculum-reactivated", curriculum-id: curriculum-id })
        (ok true)
    )
)