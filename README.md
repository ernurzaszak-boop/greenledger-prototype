Educational project for the course Introduction to Finance. Not a real product, service or investment offer. Do not use with real funds.

# GreenLedger Prototype (Hardhat Local Network)

**Course:** Introduction to Finance, Astana IT University (2026-2027)  
**Supervisor:** Nurkhat Ibadildin, Associate Professor  
**Team Members:** Temur Dias, Khalilov Mardan, Ernur Zhasyuzak  

## Demo Video
https://drive.google.com/file/d/16keM7cHM9CunpityfIyiJxmGobvB43ev/view?usp=sharing

## How to Run Locally
1. `npm install`
2. `npx hardhat compile`
3. `npx hardhat test`
4. `npx hardhat run scripts/demo.js`

## Settlement deadline
Settlement and new disputes are allowed only before 24 hours have elapsed since
the trade was funded. At the exact deadline and afterwards, a buyer can reclaim
the full deposit for a still-funded trade; late settlement or dispute transactions
cannot block this refund. A dispute raised before the deadline still freezes the
trade (dispute resolution is not implemented in this prototype).
