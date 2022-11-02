/* global BigInt */
import React, { useEffect, useRef, useState } from 'react';
import { bsv, buildContractClass, getPreimage, Int, PubKey, signTx } from 'scryptlib';
import { ContractUtxos, Player, PlayerPKH, PlayerPrivkey, PlayerPublicKey } from '../storage';
import { web3 } from '../web3';
import Balance from './balance';
import { GameView } from './GameView';
import { buildMimc7 } from 'circomlibjs';
import { useModal } from 'react-hooks-use-modal';

import {
  coordsToIndex, generateEmptyLayout,
  generateRandomIndex,
  getNeighbors, indexToCoords, placeAllComputerShips, putEntityInLayout, SQUARE_STATE, updateSunkShips
} from './layoutHelpers';

import Queue from "queue-promise";
import { CircomProvider } from '../circomProvider';

const AVAILABLE_SHIPS = [
  {
    name: 'carrier',
    length: 5,
    placed: null,
  },
  {
    name: 'battleship',
    length: 4,
    placed: null,
  },
  {
    name: 'cruiser',
    length: 3,
    placed: null,
  },
  {
    name: 'submarine',
    length: 3,
    placed: null,
  },
  {
    name: 'destroyer',
    length: 2,
    placed: null,
  },
];


function runCircom(privateInputs, publicInputs) {
  return CircomProvider
    .init()
    .then(async () => {
      return CircomProvider.generateProof({
        "boardHash": publicInputs[0],
        "guess": publicInputs.slice(1),
        "ships": privateInputs
      });
    })
    .then(async ({ proof, publicSignals, isHit }) => {
      const isVerified = await CircomProvider.verify({ proof, publicSignals });
      return { isVerified, proof, isHit };
    })
    .catch(e => {
      console.error('runCircom error:', e)
      return {
        isVerified: false
      }
    })
}

export const Game = ({ desc }) => {
  const [gameState, setGameState] = useState('placement');
  const [winner, setWinner] = useState(null);

  const [currentlyPlacing, setCurrentlyPlacing] = useState(null);
  const [placedShips, setPlacedShips] = useState([]);
  const [placedShipsHash, setPlacedShipsHash] = useState([]);
  const [availableShips, setAvailableShips] = useState(AVAILABLE_SHIPS);
  const [computerShips, setComputerShips] = useState([]);
  const [computerShipsHash, setComputerShipsHash] = useState([]);
  const [hitsByPlayer, setHitsByPlayer] = useState([]);
  const [hitsByComputer, setHitsByComputer] = useState([]);
  const [hitsProofToComputer, setHitsProofToComputer] = useState(new Map()); // index: number => {status: 'pending'/'verified', proof?: object}
  const [hitsProofToPlayer, setHitsProofToPlayer] = useState(new Map()); // structure same as above
  const [battleShipContract, setBattleShipContract] = useState(null); // contract
  const [deployTxid, setDeployTxid] = useState('');
  const [balance, setBalance] = useState(-1);
  const [queue, setQueue] = useState(null);
  const [description, setDescription] = useState('Please use the wallet to sign the transaction.');

  

  const [Modal, open, close, isOpen] = useModal('root', {
    preventScroll: true,
    focusTrapOptions: {
      clickOutsideDeactivates: false,
    },
    components: {
      Modal: ({ title, description, children }) => {
        return (
          <div
            style={{
              padding: '60px 100px',
              backgroundColor: '#fff',
              borderRadius: '10px',
            }}
          >
            {title && <h1>{title}</h1>}
            <br></br>
            {description && <p>{description}</p>}
            {children}
          </div>
        );
      },
      Overlay: () => {
        return (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              bottom: 0,
              right: 0,
              backgroundColor: 'rgba(0, 0, 0, 0.5)',
            }}
          />
        );
      },
      Wrapper: ({ children }) => {
        return (
          <div
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              bottom: 0,
              right: 0,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              zIndex: 1000,
            }}
          >
            {children}
          </div>
        );
      },
    },
  });

  const hp2CRef = useRef(hitsProofToComputer);
  useEffect(() => {
    hp2CRef.current = hitsProofToComputer
  }, [hitsProofToComputer]);

  const hp2PRef = useRef(hitsProofToPlayer);
  useEffect(() => {
    hp2PRef.current = hitsProofToPlayer
  }, [hitsProofToPlayer]);

  const hbpRef = useRef(hitsByPlayer);
  useEffect(() => {
    hbpRef.current = hitsByPlayer
  }, [hitsByPlayer]);

  const hbcRef = useRef(hitsByComputer);
  useEffect(() => {
    hbcRef.current = hitsByComputer
  }, [hitsByComputer]);

  useEffect(() => {
    const queue = new Queue({
      concurrent: 1,
      interval: 2000
    });

    setQueue(queue)

    return (() => {
      queue.stop();
    })
  }, []);



  // *** PLAYER ***
  const selectShip = (shipName) => {
    let shipIdx = availableShips.findIndex((ship) => ship.name === shipName);
    const shipToPlace = availableShips[shipIdx];

    setCurrentlyPlacing({
      ...shipToPlace,
      orientation: 'horizontal',
      position: null,
    });
  };

  const move = async (isPlayerFired, index, contractUtxo, hit, proof, newStates) => {

    console.log('call move ...', 'index=', index, newStates, contractUtxo)


    console.time('t0')
    return web3.call(contractUtxo, async (tx) => {

      if (newStates.successfulYourHits === 17) {
        const amount = contractUtxo.satoshis - tx.getEstimateFee();

        if (amount < 1) {
          alert('Not enough funds.');
          throw new Error('Not enough funds.')
        }

        tx.setOutput(0, (tx) => {
          return new bsv.Transaction.Output({
            script: bsv.Script.buildPublicKeyHashOut(PlayerPKH.get(Player.Computer)),
            satoshis: amount,
          })
        })

      } else if (newStates.successfulComputerHits === 17) {
        tx.setOutput(0, (tx) => {
          const amount = contractUtxo.satoshis - tx.getEstimateFee();
          if (amount < 1) {
            alert('Not enough funds.');
            throw new Error('Not enough funds.')
          }

          return new bsv.Transaction.Output({
            script: bsv.Script.buildPublicKeyHashOut(PlayerPKH.get(Player.You)),
            satoshis: amount,
          })
        })

      } else {
        tx.setOutput(0, (tx) => {
          const amount = contractUtxo.satoshis - tx.getEstimateFee();

          if (amount < 1) {
            alert('Not enough funds.');
            throw new Error('Not enough funds.')
          }

          const newLockingScript = battleShipContract.getNewStateScript(newStates);

          return new bsv.Transaction.Output({
            script: newLockingScript,
            satoshis: amount,
          })
        })
      }


      tx.setInputScript(0, (tx, output) => {
        const preimage = getPreimage(tx, output.script, output.satoshis)
        const currentTurn = !newStates.yourTurn;
        const privateKey = new bsv.PrivateKey.fromWIF(currentTurn ? PlayerPrivkey.get(Player.You) : PlayerPrivkey.get(Player.Computer));
        const sig = signTx(tx, privateKey, output.script, output.satoshis)
        const position = indexToCoords(index);

        let amount = contractUtxo.satoshis - tx.getEstimateFee();

        if (amount < 1) {
          alert('Not enough funds.');
          throw new Error('Not enough funds.')
        }

        return battleShipContract.move(sig, position.x, position.y, hit, proof, amount, preimage).toScript();
      })
        .seal();


    }).then(async rawTx => {
      console.timeEnd('t0')
      ContractUtxos.add(rawTx, isPlayerFired, index);

      battleShipContract.successfulYourHits = newStates.successfulYourHits;
      battleShipContract.successfulComputerHits = newStates.successfulComputerHits;
      battleShipContract.yourTurn = newStates.yourTurn;
      battleShipContract.yourHits = newStates.yourHits;
      battleShipContract.computerHits = newStates.computerHits;

      

      setTimeout(async () => {
        web3.wallet.getbalance().then(balance => {
          console.log('update balance:', balance)
          setBalance(balance)
        })
      }, 5000);

    })
      .catch(e => {
        console.error('call contract fail', e)
      })

  }

  const placeShip = (currentlyPlacing) => {
    setPlacedShips([
      ...placedShips,
      {
        ...currentlyPlacing,
        placed: true,
      },
    ]);

    setAvailableShips((previousShips) =>
      previousShips.filter((ship) => ship.name !== currentlyPlacing.name)
    );

    setCurrentlyPlacing(null);
  };

  const rotateShip = (event) => {
    if (currentlyPlacing != null && event.button === 2) {
      setCurrentlyPlacing({
        ...currentlyPlacing,
        orientation:
          currentlyPlacing.orientation === 'vertical' ? 'horizontal' : 'vertical',
      });
    }
  };

  const startTurn = async () => {

    const computerShips_ = generateComputerShips();
    const BattleShip = buildContractClass(desc);

    const playerHash = await shipHash(placedShips);
    const computerHash = await shipHash(computerShips_);

    const contract = new BattleShip(new PubKey(PlayerPublicKey.get(Player.You)),
      new PubKey(PlayerPublicKey.get(Player.Computer)),
      new Int(playerHash), new Int(computerHash), 0, 0, true,new Array(100).fill(false),new Array(100).fill(false) );

    setBattleShipContract(contract);

    try {

      ContractUtxos.clear();

      open()

      const rawTx = await web3.deploy(contract, 20000);

      setDescription("Broadcasting transaction...")
      open()
      await web3.sendRawTx(rawTx)

      close()

      ContractUtxos.add(rawTx, 0, -1);

      const txid = ContractUtxos.getdeploy().utxo.txId

      setDeployTxid(txid)

      setTimeout(async () => {
        web3.wallet.getbalance().then(balance => {
          console.log('update balance:', balance)
          setBalance(balance)
        })
      }, 10000);
    } catch (error) {
      console.error("Deploying contract failed", error);
      setBattleShipContract(null);
      setDescription("Deploying contract failed:" + error.message)
      open()
      return;
    }


    setGameState('player-turn');

    setPlacedShipsHash(playerHash);

    setComputerShipsHash(computerHash);
  };

  const changeTurn = () => {
    setGameState((oldGameState) =>
      oldGameState === 'player-turn' ? 'computer-turn' : 'player-turn'
    );
  };

  // *** COMPUTER ***
  const generateComputerShips = () => {
    let placedComputerShips = placeAllComputerShips(AVAILABLE_SHIPS.slice());

    setComputerShips(placedComputerShips);
    return placedComputerShips
  };

  const computerFire = (index, layout) => {
    let computerHits;
    let fireResult;
    if (layout[index] === 'ship') {
      fireResult = {
        position: indexToCoords(index),
        type: SQUARE_STATE.hit,
      };
      computerHits = [
        ...hitsByComputer,
        fireResult,
      ];
    }
    if (layout[index] === 'empty') {
      fireResult = {
        position: indexToCoords(index),
        type: SQUARE_STATE.miss,
      }
      computerHits = [
        ...hitsByComputer,
        fireResult,
      ];
    }
    const sunkShips = updateSunkShips(computerHits, placedShips);
    const sunkShipsAfter = sunkShips.filter((ship) => ship.sunk).length;
    const sunkShipsBefore = placedShips.filter((ship) => ship.sunk).length;
    if (sunkShipsAfter > sunkShipsBefore) {
      playSound('sunk');
    }
    setPlacedShips(sunkShips);
    setHitsByComputer(computerHits);

    if (fireResult) {

      let successfulYourHits = hbpRef.current.filter((hit) => hit.type === 'hit').length;
      let successfulComputerHits = computerHits.filter((hit) => hit.type === 'hit')
        .length;

      const yourHits_ =  new Array(100).fill(false);
      const computerHits_ =  new Array(100).fill(false);

      hbpRef.current.map((hit) => coordsToIndex(hit.position)).forEach(v => {
        yourHits_[v] = true
      })

      computerHits.map((hit) => coordsToIndex(hit.position)).forEach(v => {
        computerHits_[v] = true
      })


      handleFire('computer', index, {
        successfulYourHits: successfulYourHits,
        successfulComputerHits: successfulComputerHits,
        yourTurn: true,
        yourHits: yourHits_,
        computerHits: computerHits_
      });
    }
  };

  // Change to computer turn, check if game over and stop if yes; if not fire into an eligible square
  const handleComputerTurn = () => {
    changeTurn();

    if (checkIfGameOver()) {
      return;
    }

    // Recreate layout to get eligible squares
    let layout = placedShips.reduce(
      (prevLayout, currentShip) =>
        putEntityInLayout(prevLayout, currentShip, SQUARE_STATE.ship),
      generateEmptyLayout()
    );

    layout = hitsByComputer.reduce(
      (prevLayout, currentHit) =>
        putEntityInLayout(prevLayout, currentHit, currentHit.type),
      layout
    );

    layout = placedShips.reduce(
      (prevLayout, currentShip) =>
        currentShip.sunk
          ? putEntityInLayout(prevLayout, currentShip, SQUARE_STATE.ship_sunk)
          : prevLayout,
      layout
    );

    let successfulComputerHits = hitsByComputer.filter((hit) => hit.type === 'hit');

    let nonSunkComputerHits = successfulComputerHits.filter((hit) => {
      const hitIndex = coordsToIndex(hit.position);
      return layout[hitIndex] === 'hit';
    });

    let potentialTargets = nonSunkComputerHits
      .flatMap((hit) => getNeighbors(hit.position))
      .filter((idx) => layout[idx] === 'empty' || layout[idx] === 'ship');

    // Until there's a successful hit
    if (potentialTargets.length === 0) {
      let layoutIndices = layout.map((item, idx) => idx);
      potentialTargets = layoutIndices.filter(
        (index) => layout[index] === 'ship' || layout[index] === 'empty'
      );
    }

    let randomIndex = generateRandomIndex(potentialTargets.length);

    let target = potentialTargets[randomIndex];

    setTimeout(() => {
      computerFire(target, layout);
      changeTurn();
    }, 300);
  };

  // *** END GAME ***

  // Check if either player or computer ended the game
  const checkIfGameOver = () => {
    let successfulPlayerHits = hitsByPlayer.filter((hit) => hit.type === 'hit').length;
    let successfulComputerHits = hitsByComputer.filter((hit) => hit.type === 'hit')
      .length;

    if (successfulComputerHits === 17 || successfulPlayerHits === 17) {
      setGameState('game-over');

      if (successfulComputerHits === 17) {
        setWinner('computer');
        playSound('lose');
      }
      if (successfulPlayerHits === 17) {
        setWinner('player');
        playSound('win');
      }

      return true;
    }

    return false;
  };

  const startAgain = () => {
    setGameState('placement');
    setWinner(null);
    setCurrentlyPlacing(null);
    setPlacedShips([]);
    setAvailableShips(AVAILABLE_SHIPS);
    setComputerShips([]);
    setHitsByPlayer([]);
    setHitsByComputer([]);
    setHitsProofToComputer(new Map());
    setHitsProofToPlayer(new Map());
    ContractUtxos.clear();
  };

  const handleFire = (role, targetIdx, newStates) => {
    const isPlayerFired = role === 'player';
    const privateInputs = toPrivateInputs(isPlayerFired ? computerShips : placedShips);
    const position = indexToCoords(targetIdx);
    const publicInputs = [isPlayerFired ? computerShipsHash : placedShipsHash, position.x, position.y];

    if (isPlayerFired) {
      setHitsProofToPlayer(new Map(hitsProofToPlayer.set(targetIdx, { status: 'pending' })));
    } else {
      setHitsProofToComputer(new Map(hitsProofToComputer.set(targetIdx, { status: 'pending' })));
    }


    queue.enqueue(async () => {
      await runCircom(privateInputs, publicInputs)
      .then(async ({isVerified, proof, isHit }) => {
        console.log("isVerified", isVerified)
        console.log("isHit", isHit)
        console.log(proof)
        
        const isPlayerFired = role === 'player';

        const contractUtxo = ContractUtxos.getlast().utxo;

        const Proof = battleShipContract.getTypeClassByType("Proof");
        const G1Point = battleShipContract.getTypeClassByType("G1Point");
        const G2Point = battleShipContract.getTypeClassByType("G2Point");
        const FQ2 = battleShipContract.getTypeClassByType("FQ2");

        contractUtxo.script = battleShipContract.lockingScript.toHex();

        await move(isPlayerFired, targetIdx, contractUtxo, isHit, new Proof({
          a: new G1Point({
            x: new Int(proof.pi_a[0]),
            y: new Int(proof.pi_a[1]),
          }),
          b: new G2Point({
            x: new FQ2({
              x: new Int(proof.pi_b[0][0]),
              y: new Int(proof.pi_b[0][1]),
            }),
            y: new FQ2({
              x: new Int(proof.pi_b[1][0]),
              y: new Int(proof.pi_b[1][1]),
            })
          }),
          c: new G1Point({
            x: new Int(proof.pi_c[0]),
            y: new Int(proof.pi_c[1]),
          })
        }), newStates)
          .then(() => {

            if (isPlayerFired) {
              setHitsProofToPlayer(new Map(hp2PRef.current.set(targetIdx, { status: isVerified ? 'verified' : 'failed', proof })))
            } else {
              setHitsProofToComputer(new Map(hp2CRef.current.set(targetIdx, { status: isVerified ? 'verified' : 'failed', proof })))
            }
          })
          .catch(e => {
            console.error("call contract error:", e);
            alert("call contract error:" + e.message);
          })
      });
    });

    

  }

  // *** Zero Knowledge Proof

  const sortShipsForZK = (ships) => {
    const SORTED_ZK_SHIP_NAMES = ['carrier', 'battleship', 'cruiser', 'submarine', 'destoryer'];
    return ships.sort((a, b) => SORTED_ZK_SHIP_NAMES.indexOf(a) - SORTED_ZK_SHIP_NAMES.indexOf(b))
  }

  const shipHash = async (ships) => {
    let multiplier = 1n;
    const shipPreimage =
      sortShipsForZK(ships)
        .reduce(
          (res, ship) => {
            const val = ship.position.x + ship.position.y * 16 + (ship.orientation === "horizontal" ? 1 : 0) * 16 * 16
            const r = res + BigInt(val) * multiplier;
            multiplier *= BigInt(16 ** 3);
            return r;
          },
          BigInt(0)
        );

    const mimc7 = await buildMimc7();
    return mimc7.F.toString(mimc7.hash(shipPreimage, 0));
  }

  const toPrivateInputs = (ships) => {

    return ships.map(ship =>
      [
        ship.position.x,
        ship.position.y,
        ship.orientation === "horizontal" ? 1 : 0
      ]
    )
  }


  const sunkSoundRef = useRef(null);
  const clickSoundRef = useRef(null);
  const lossSoundRef = useRef(null);
  const winSoundRef = useRef(null);

  const stopSound = (sound) => {
    sound.current.pause();
    sound.current.currentTime = 0;
  };
  const playSound = (sound) => {
    if (sound === 'sunk') {
      stopSound(sunkSoundRef);
      sunkSoundRef.current.play();
    }

    if (sound === 'click') {
      stopSound(clickSoundRef);
      clickSoundRef.current.play();
    }

    if (sound === 'lose') {
      stopSound(lossSoundRef);
      lossSoundRef.current.play();
    }

    if (sound === 'win') {
      stopSound(winSoundRef);
      winSoundRef.current.play();
    }
  };
  return (
    <React.Fragment>
      <audio
        ref={sunkSoundRef}
        src="/zk-battleship/sounds/ship_sunk.wav"
        className="clip"
        preload="auto"
      />
      <audio
        ref={clickSoundRef}
        src="/zk-battleship/sounds/click.wav"
        className="clip"
        preload="auto"
      />
      <audio ref={lossSoundRef} src="/zk-battleship/sounds/lose.wav" className="clip" preload="auto" />
      <audio ref={winSoundRef} src="/zk-battleship/sounds/win.wav" className="clip" preload="auto" />
      <GameView
        availableShips={availableShips}
        selectShip={selectShip}
        currentlyPlacing={currentlyPlacing}
        setCurrentlyPlacing={setCurrentlyPlacing}
        rotateShip={rotateShip}
        placeShip={placeShip}
        placedShips={placedShips}
        startTurn={startTurn}
        computerShips={computerShips}
        computerShipsHash={computerShipsHash}
        gameState={gameState}
        changeTurn={changeTurn}
        hitsByPlayer={hitsByPlayer}
        setHitsByPlayer={setHitsByPlayer}
        hitsByComputer={hitsByComputer}
        hitsProofToComputer={hitsProofToComputer}
        hitsProofToPlayer={hitsProofToPlayer}
        setHitsByComputer={setHitsByComputer}
        handleComputerTurn={handleComputerTurn}
        checkIfGameOver={checkIfGameOver}
        startAgain={startAgain}
        winner={winner}
        setComputerShips={setComputerShips}
        playSound={playSound}
        deployTxid={deployTxid}
        handleFire={handleFire}
      />
      <Balance balance={balance}></Balance>
      <Modal title="Deploying" description={description}>
        <div>
          <button onClick={close}>CLOSE</button>
        </div>
      </Modal>
    </React.Fragment>
  );
};
