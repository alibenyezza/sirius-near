// Généré par `pnpm contracts:abi` — ne pas modifier à la main.
// Source : contracts/src/SiriusDatasetRegistry.sol

export const siriusdatasetregistryAbi = [
  {
    "inputs": [
      {
        "internalType": "contract SiriusKybRegistry",
        "name": "kyb_",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "admin_",
        "type": "address"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "inputs": [],
    "name": "AlreadyDestroyed",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "datasetId",
        "type": "bytes32"
      }
    ],
    "name": "DatasetExists",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "datasetId",
        "type": "bytes32"
      },
      {
        "internalType": "uint256",
        "name": "activeLoans",
        "type": "uint256"
      }
    ],
    "name": "DatasetInUse",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "EmptyDatasetId",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "EscrowAlreadyBound",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidCid",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidMerkleRoot",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSize",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidTrainingProfile",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "KybRequired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotAdmin",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotProvider",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "datasetId",
        "type": "bytes32"
      }
    ],
    "name": "UnknownDataset",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ZeroAddress",
    "type": "error"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "datasetId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "provider",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "uint40",
        "name": "destroyedAt",
        "type": "uint40"
      }
    ],
    "name": "DatasetDestroyed",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "datasetId",
        "type": "bytes32"
      },
      {
        "indexed": true,
        "internalType": "address",
        "name": "provider",
        "type": "address"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "cidHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "merkleRoot",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint64",
        "name": "sizeBytes",
        "type": "uint64"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "trainingProfile",
        "type": "bytes32"
      }
    ],
    "name": "DatasetMinted",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "escrow",
        "type": "address"
      }
    ],
    "name": "EscrowBound",
    "type": "event"
  },
  {
    "inputs": [],
    "name": "DATASET_ID_DOMAIN",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "LINEAR_REGRESSION_V1_PROFILE",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "LOGISTIC_REGRESSION_V1_PROFILE",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "MAX_SIZE_BYTES",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "",
        "type": "uint64"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "VERSION",
    "outputs": [
      {
        "internalType": "string",
        "name": "",
        "type": "string"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "admin",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "contract ISiriusDatasetEscrow",
        "name": "escrow_",
        "type": "address"
      }
    ],
    "name": "bindEscrow",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "provider",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "datasetIdHash",
        "type": "bytes32"
      }
    ],
    "name": "datasetIdOf",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "",
        "type": "bytes32"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "datasetIdHash",
        "type": "bytes32"
      }
    ],
    "name": "destroy",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "id",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "escrow",
    "outputs": [
      {
        "internalType": "contract ISiriusDatasetEscrow",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "id",
        "type": "bytes32"
      }
    ],
    "name": "getDataset",
    "outputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "provider",
            "type": "address"
          },
          {
            "internalType": "uint40",
            "name": "mintedAt",
            "type": "uint40"
          },
          {
            "internalType": "uint40",
            "name": "destroyedAt",
            "type": "uint40"
          },
          {
            "internalType": "uint64",
            "name": "sizeBytes",
            "type": "uint64"
          },
          {
            "internalType": "bytes32",
            "name": "merkleRoot",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "cidHash",
            "type": "bytes32"
          },
          {
            "internalType": "bytes32",
            "name": "trainingProfile",
            "type": "bytes32"
          }
        ],
        "internalType": "struct SiriusDatasetRegistry.Dataset",
        "name": "",
        "type": "tuple"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "id",
        "type": "bytes32"
      }
    ],
    "name": "isLive",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "id",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "provider",
        "type": "address"
      }
    ],
    "name": "isLiveForProvider",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "id",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "provider",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "trainingProfile",
        "type": "bytes32"
      }
    ],
    "name": "isLiveForProviderAndProfile",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "trainingProfile",
        "type": "bytes32"
      }
    ],
    "name": "isSupportedTrainingProfile",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "pure",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "kyb",
    "outputs": [
      {
        "internalType": "contract SiriusKybRegistry",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "liveCount",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "id",
        "type": "bytes32"
      },
      {
        "internalType": "address",
        "name": "provider",
        "type": "address"
      },
      {
        "internalType": "bytes32",
        "name": "merkleRoot",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "cidHash",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "trainingProfile",
        "type": "bytes32"
      }
    ],
    "name": "matchesScope",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "datasetIdHash",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "cidHash",
        "type": "bytes32"
      },
      {
        "internalType": "bytes32",
        "name": "merkleRoot",
        "type": "bytes32"
      },
      {
        "internalType": "uint64",
        "name": "sizeBytes",
        "type": "uint64"
      },
      {
        "internalType": "bytes32",
        "name": "trainingProfile",
        "type": "bytes32"
      }
    ],
    "name": "mint",
    "outputs": [
      {
        "internalType": "bytes32",
        "name": "id",
        "type": "bytes32"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;
