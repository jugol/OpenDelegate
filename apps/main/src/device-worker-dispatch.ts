import type { WorkerRunSteeringCommandV1 } from "@opendelegate/device-channel";
import type { WorkerRunDispatchPort } from "@opendelegate/task-service";

type EnqueueWorkerRun = Parameters<WorkerRunDispatchPort["enqueue"]>[0];
type CancelWorkerRun = Parameters<NonNullable<WorkerRunDispatchPort["cancel"]>>[0];

interface DurableMainDeviceChannel {
  dispatch(
    deviceId: string,
    assignment: EnqueueWorkerRun["assignment"],
    correlationId: string,
    idempotencyKey: string,
  ): Promise<unknown>;
  control(
    deviceId: string,
    control: {
      readonly action: "cancel";
      readonly reason: string;
      readonly runId: string;
      readonly leaseId: string;
      readonly fencingToken: number;
    },
    correlationId: string,
    idempotencyKey: string,
  ): Promise<unknown>;
  steerRun(deviceId: string, command: WorkerRunSteeringCommandV1): Promise<unknown>;
}

export interface MainWorkerRunSteeringPort {
  steer(input: WorkerRunSteeringCommandV1): Promise<void>;
}

/**
 * Adapts authoritative Run commands to the durable Main Device-channel outbox.
 * The channel owns delivery and replay; this port never translates a socket send
 * into evidence that the Worker performed the assignment.
 */
export class MainDeviceChannelWorkerRunDispatchPort
  implements WorkerRunDispatchPort, MainWorkerRunSteeringPort
{
  readonly #channel: DurableMainDeviceChannel;

  public constructor(channel: DurableMainDeviceChannel) {
    this.#channel = channel;
  }

  public async enqueue(input: EnqueueWorkerRun): Promise<void> {
    await this.#channel.dispatch(
      input.assignment.deviceId,
      input.assignment,
      input.assignment.taskId,
      input.idempotencyKey,
    );
  }

  public async cancel(input: CancelWorkerRun): Promise<void> {
    await this.#channel.control(
      input.assignment.deviceId,
      {
        action: "cancel",
        reason: input.reason,
        runId: input.assignment.runId,
        leaseId: input.assignment.leaseId,
        fencingToken: input.assignment.fencingToken,
      },
      input.assignment.taskId,
      input.idempotencyKey,
    );
  }

  public async steer(input: WorkerRunSteeringCommandV1): Promise<void> {
    await this.#channel.steerRun(input.deviceId, input);
  }
}
