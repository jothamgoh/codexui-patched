export class ReviewMutationConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReviewMutationConflictError'
  }
}

export class ReviewMutationGate {
  private reviewReservations = 0
  private turnStartsInFlight = 0
  private readonly activeTurnIds = new Set<string>()
  private readonly recentlyCompletedTurnIds = new Set<string>()
  private readonly recentlyCompletedOrder: string[] = []

  reserveTurnStart(): () => void {
    if (this.reviewReservations > 0) {
      throw new ReviewMutationConflictError(
        'Wait for the Review Changes action to finish before starting a turn.',
      )
    }
    this.turnStartsInFlight += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.turnStartsInFlight = Math.max(0, this.turnStartsInFlight - 1)
    }
  }

  reserveReview(): () => void {
    if (this.reviewReservations > 0) {
      throw new ReviewMutationConflictError(
        'Wait for the current repository change to finish before starting another.',
      )
    }
    if (this.turnStartsInFlight > 0 || this.activeTurnIds.size > 0) {
      throw new ReviewMutationConflictError(
        'Wait for all active Codex turns to finish before changing earlier edits.',
      )
    }
    this.reviewReservations += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.reviewReservations = Math.max(0, this.reviewReservations - 1)
    }
  }

  markTurnStarted(turnId: string): void {
    if (!turnId) return
    if (this.recentlyCompletedTurnIds.has(turnId)) return
    this.activeTurnIds.add(turnId)
  }

  markTurnCompleted(turnId: string): void {
    if (!turnId) return
    this.activeTurnIds.delete(turnId)
    if (this.recentlyCompletedTurnIds.has(turnId)) return
    this.recentlyCompletedTurnIds.add(turnId)
    this.recentlyCompletedOrder.push(turnId)
    while (this.recentlyCompletedOrder.length > 256) {
      const expired = this.recentlyCompletedOrder.shift()
      if (expired) this.recentlyCompletedTurnIds.delete(expired)
    }
  }

  resetTurns(): void {
    this.turnStartsInFlight = 0
    this.activeTurnIds.clear()
    this.recentlyCompletedTurnIds.clear()
    this.recentlyCompletedOrder.splice(0)
  }
}
