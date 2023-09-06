import { PrismaClient } from '@prisma/client';
import { RoomI, getRateCommitmentHash } from 'discreetly-interfaces';
const prisma = new PrismaClient();

/**
 * This function takes in an identity and a room and removes the identity from the room
 * by setting its semaphoreIdentities to 0n and identities to 0n
 * @param {string} idc - The identity of the user
 * @param {RoomI} room - The room to remove the identity from
 * @returns {Promise<void | RoomI>} - A promise that resolves to the room
 */
export function removeIdentityFromRoom(idc: string, room: RoomI): Promise<void | RoomI> {
  const updateSemaphoreIdentities =
    room.semaphoreIdentities?.map((identity) => (identity === idc ? '0' : (identity as string))) ??
    [];

  const rateCommitmentsToUpdate = getRateCommitmentHash(
    BigInt(idc),
    BigInt(room.userMessageLimit!)
  ).toString();

  const updatedRateCommitments =
    room.identities?.map((limiter) =>
      limiter == rateCommitmentsToUpdate ? '0' : (limiter as string)
    ) ?? [];

  return prisma.rooms
    .update({
      where: { id: room.id },
      data: {
        identities: updatedRateCommitments,
        semaphoreIdentities: updateSemaphoreIdentities
      }
    })
    .then((room) => {
      return room as RoomI;
    })
    .catch((err) => {
      console.error(err);
    });
}

export function removeRoom(roomId: string) {
  console.warn('removeRoom not implemented', roomId);
  //TODO removeRoom function
}

export function removeMessage(roomId: string, messageId: string) {
  console.warn('removeMessage not implemented', roomId, messageId);
  //TODO removeMessage function
}
