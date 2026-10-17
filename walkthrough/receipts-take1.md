# 100x.broker walkthrough receipts (local mainnet fork)

| scene | action | result | signature |
|---|---|---|---|
| market | ape UP $PUMP 0.05 SOL | ok | `2u3WHEeMeYv1wffcmqyzeyhVk6zmW5umJNwBJkxffwKn8vzeZqQnnHz83CK2UNh4zs9iCr5KeBYynVG17nyLaozH` |
| market | sell 50% UP $PUMP | ok | `zBhdhCVrALegASDQTkdN5YrNRJghKv6ogpkxxvkvQdteK9n72uHUtefuFLk4oq6PwHof71kAkjNL7SydA3qxmDB` |
| wrap | wrap PUMPUP → SPL twin | ok | `3vAf9LxM1aR5ruS5mskqvTXnoHnRjJWHhnZP4uo1cXjGhfnmacJYrYaZnhdscZP3iS3EwBhuCjGj7qm8U8Rki7XH` |
| wrap | unwrap twin → PUMPUP | ok | `5jLrn9SMKze5tpMVA1dhFQUcrtN3jad2dR75XZXAmHKheaMbqYwsT5QZArZz7Yoe6txhhpgasaeT4U3qwfq2uZps` |
| yield | park 0.2 SOL in $PUMP vault: Park SOL, mint receipts | ok | `UPBDcFyza2QD7EpsAnCALigiHqJHhCVqCb1fvKq9JFBD7aQzkTS6Yxu33d6Z5VQAD1hS4tzkcpv3AspQQPgcE6h` |
| yield | unpark 100% of $PUMP vault: Unpark in kind | ok | `2JMfsYEjJeinhHRnEhnp1vPoo5uHcQ1SnRYbWukNaWt9HMC9a2hnu5WtdAeNB9X8o6BU4DVo6dfcQZGmVJWj5rGR` |
| yield | unpark 100% of $PUMP vault: Turn it all back into SOL | ok | `5ytLZDWhwnGesHmJRwU7z69YB66vL5vkG1wRRvagBEaWPCRTBESdUciwbN4n6Z2a4upijXXmeGxnweXdFpyDq1gt` |
| yield | unpark 100% of $PUMP vault: 0/20 → STACCIndex (0.35 USDC) | ok | `Yo9qM6SZnzYq2Gfvs5zxKimmCD9PVdkiAKsLg6MEbX3ME3pv8v1NTdtYhVLUqs5NsjeDeNLv1uVPXUFCo2aTgX8` |
| swapbag | sell DOWN $Pump from the swap bag | ok | `3Xuyw1WMZCCAZfZqCdznyXeYzo7YvxQAabRUw7mBxeQzzMVW7t6qZcdaGALBAF93oecZ8pKm9pkoNJcjzj9EULwQ` |
| list | list $BONK: Curve config | ok | `5sxzzXxWm4GR377HYaeq9JRaPAdMi5k7g2yvh6Dt1s8QMbT5mnPHf3ytKKBxzJ3jobmEv4cSXor3CehpSgzvzfW7` |
| list | list $BONK: UP curve | ok | `3YsBbZPZaQRmRC3hUamPTXUuSPZkTUQaTW4Cfw1JfiyGTXukXKmQCqMR26dVqR6mbSkSPGEzSSfoJoKxxyd1YPci` |
| list | list $BONK: DOWN curve | ok | `4ciNqkE6nvaHMHN6G9ySoEFLaqSzpnTfbSwzyZFogx5ZQ3bApjdB5tLi7tpPsdAxxXjYmvfytffKsyB4AUgVSJ71` |
| list | list $BONK: Market + vaults | ok | `4mmJwMXfMY7UJCXfcD31hJCLqhnqm6Nh7nqd8JnbZGZL8H6LhxYpJWqqqpesrujFTg5zVMZ2kmysws2ovempn37n` |
