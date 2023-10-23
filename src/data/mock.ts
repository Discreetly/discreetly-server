/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { faker } from '@faker-js/faker';
import { MessageI } from 'discreetly-interfaces';
import { Server as SocketIOServer } from 'socket.io';

export default function Mock(io: SocketIOServer): NodeJS.Timer {
  class randomMessagePicker {
    values: any[];
    weightSums: number[];
    constructor(values, weights) {
      this.values = values;
      this.weightSums = [];
      let sum = 0;

      for (const weight of weights) {
        sum += weight;
        this.weightSums.push(sum);
      }
    }

    pick() {
      const rand = Math.random() * this.weightSums[this.weightSums.length - 1];
      const index = this.weightSums.findIndex((sum) => rand < sum);
      return this.values[index]();
    }
  }

  const values = [
    faker.finance.ethereumAddress,
    faker.company.buzzPhrase,
    faker.lorem.sentence,
    faker.hacker.phrase
  ];
  const weights = [1, 3, 2, 8];
  const picker = new randomMessagePicker(values, weights);

  return setInterval(() => {
    const message: MessageI = {
      id: faker.number.bigInt().toString(),
      roomId: BigInt(
        '15365950124115259122299397335353503712492707509718474633204755132763780105662'
      ),
      message: picker.pick(),
      timeStamp: Date.now().toString(),
      epoch: Math.floor(Date.now() / 10000)
    };
    console.log('SENDING TEST MESSAGE');
    io.to('15365950124115259122299397335353503712492707509718474633204755132763780105662').emit(
      'messageBroadcast',
      message
    );
  }, 10000);
}
