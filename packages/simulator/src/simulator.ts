import { isDeepStrictEqual } from "node:util";

import { InMemoryEventStore, type EventDraft, type StoredEvent } from "@opendelegate/event-store";

import { createCanonicalJourneyPlan } from "./canonical-journey.ts";
import {
  SimulatorError,
  type CanonicalTaskJourneySimulatorOptions,
  type TaskJourneyProjection,
} from "./contracts.ts";
import { projectTaskJourney } from "./projector.ts";

export class CanonicalTaskJourneySimulator {
  private readonly streamId: string;
  private readonly plan: readonly EventDraft[];
  private readonly initialization: Promise<void>;
  private readonly journal: InMemoryEventStore;

  public constructor(options: CanonicalTaskJourneySimulatorOptions) {
    this.plan = createCanonicalJourneyPlan(options.ids);
    this.streamId = canonicalStreamId(this.plan);
    this.journal = new InMemoryEventStore({ clock: options.clock });

    const recordedEvents = options.recordedEvents ?? [];
    for (const event of recordedEvents) {
      const recordedStreamId = (event as Partial<StoredEvent>).streamId;
      if (recordedStreamId !== undefined && recordedStreamId !== this.streamId) {
        throw new SimulatorError(
          "SIMULATOR_JOURNAL_DIVERGED",
          `Recorded event ${event.eventId} belongs to stream ${recordedStreamId}, not ${this.streamId}.`,
        );
      }
    }
    this.initialization = this.restoreEvents(recordedEvents);
  }

  public async restore(): Promise<TaskJourneyProjection> {
    return projectTaskJourney(await this.recordedEvents());
  }

  public async runToCompletion(): Promise<TaskJourneyProjection> {
    await this.initialization;
    await this.assertCanonicalPrefix();

    for (
      let index = await this.journal.streamVersion(this.streamId);
      index < this.plan.length;
      index += 1
    ) {
      const event = this.plan[index];
      if (event === undefined) {
        throw new SimulatorError(
          "SIMULATOR_JOURNAL_DIVERGED",
          `Canonical journey event ${String(index)} is missing.`,
        );
      }
      await this.journal.append({
        streamId: this.streamId,
        expectedVersion: index,
        events: [event],
      });
    }

    return this.restore();
  }

  public async recordedEvents(): Promise<readonly StoredEvent[]> {
    await this.initialization;
    return this.journal.readStream(this.streamId);
  }

  private async assertCanonicalPrefix(): Promise<void> {
    const recorded = await this.recordedEvents();
    if (recorded.length > this.plan.length) {
      throw new SimulatorError(
        "SIMULATOR_JOURNAL_DIVERGED",
        "The recorded Task stream is longer than the canonical journey.",
      );
    }

    for (const [index, event] of recorded.entries()) {
      const planned = this.plan[index];
      if (
        planned === undefined ||
        planned.eventId !== event.eventId ||
        planned.type !== event.type ||
        !isDeepStrictEqual(planned.payload, event.payload)
      ) {
        throw new SimulatorError(
          "SIMULATOR_JOURNAL_DIVERGED",
          `Recorded event at stream version ${String(index + 1)} is not the canonical journey event.`,
        );
      }
    }
  }

  private async restoreEvents(recordedEvents: readonly EventDraft[]): Promise<void> {
    for (const event of recordedEvents) {
      await this.journal.append({
        streamId: this.streamId,
        expectedVersion: await this.journal.streamVersion(this.streamId),
        events: [
          {
            eventId: event.eventId,
            type: event.type,
            payload: event.payload,
          },
        ],
      });
    }
  }
}

function canonicalStreamId(plan: readonly EventDraft[]): string {
  const intake = plan[0];
  if (
    intake?.type !== "task.intake-recorded" ||
    typeof intake.payload !== "object" ||
    intake.payload === null ||
    !("taskId" in intake.payload) ||
    typeof intake.payload.taskId !== "string" ||
    intake.payload.taskId.length === 0
  ) {
    throw new SimulatorError(
      "SIMULATOR_JOURNAL_DIVERGED",
      "The canonical journey does not begin with a valid Task intake event.",
    );
  }

  return intake.payload.taskId;
}
