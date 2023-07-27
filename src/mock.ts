import { faker } from '@faker-js/faker';
import { MessageI } from 'discreetly-interfaces';
import { Server as SocketIOServer } from 'socket.io';

export default function Mock(io: SocketIOServer) {
  class randomMessagePicker {
    values: any;
    weightSums: any[];
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

  setInterval(() => {
    const message: MessageI = {
      id: faker.number.bigInt().toString(),
      room: BigInt('19183659077143681680643781146130632794891748840418536690687883939418258252592'),
      message: picker.pick(),
      timestamp: Date.now().toString(),
      epoch: Math.floor(Date.now() / 10000)
    };
    console.log('SENDING TEST MESSAGE');
    io.emit('messageBroadcast', message);
  }, 10000);
}
